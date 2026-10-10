import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from sqlalchemy import select

from app.core.security import verify_access_token
from app.database.database import AsyncSessionLocal
from app.models.conversation_participants import ConversationParticipant
from app.services.connection_manager import manager
from app.services.message_service import create_message


router = APIRouter()


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    token = websocket.query_params.get("token")

    if not token:
        await websocket.close(code=1008)
        return

    try:
        user = await verify_access_token(token)
        user_id = user["id"]

    except HTTPException as exc:
        close_code = (
            1008
            if exc.status_code == 401
            else 1011
        )
        await websocket.close(code=close_code)
        return

    await manager.connect(user_id, websocket)

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") != "message.send":
                continue

            payload = data.get("payload", {})

            try:
                conversation_id = uuid.UUID(
                    payload["conversationId"]
                )
            except (KeyError, ValueError, TypeError):
                await websocket.send_json({
                    "type": "message.error",
                    "payload": {
                        "detail": "Invalid conversation ID",
                    },
                })
                continue

            content = payload.get("content", "")

            if not isinstance(content, str):
                await websocket.send_json({
                    "type": "message.error",
                    "payload": {
                        "detail": "Message content must be text",
                    },
                })
                continue

            sender_id = uuid.UUID(user_id)

            try:
                async with AsyncSessionLocal() as db:
                    message = await create_message(
                        db=db,
                        conversation_id=conversation_id,
                        sender_id=sender_id,
                        content=content,
                    )

                    result = await db.execute(
                        select(ConversationParticipant.user_id).where(
                            ConversationParticipant.conversation_id
                            == conversation_id
                        )
                    )

                    participant_ids = result.scalars().all()

            except HTTPException as exc:
                await websocket.send_json({
                    "type": "message.error",
                    "payload": {
                        "detail": exc.detail,
                    },
                })
                continue

            message_data = {
                "id": str(message.id),
                "conversationId": str(message.conversation_id),
                "senderId": str(message.sender_id),
                "content": message.content,
                "createdAt": message.created_at.isoformat(),
                "status": message.status,
            }

            for participant_id in participant_ids:
                await manager.send_to_user(
                    str(participant_id),
                    {
                        "type": "message.new",
                        "payload": message_data,
                    },
                )

    except WebSocketDisconnect:
        pass

    finally:
        manager.disconnect(user_id, websocket)