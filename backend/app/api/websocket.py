import uuid

import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

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
        payload = jwt.decode(
            token,
            options={"verify_signature": False},
            audience="authenticated",
        )

        user_id = payload.get("sub")

        if not user_id:
            await websocket.close(code=1008)
            return

    except jwt.InvalidTokenError:
        await websocket.close(code=1008)
        return

    await manager.connect(user_id, websocket)

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") != "message.send":
                continue

            payload = data.get("payload", {})

            conversation_id = uuid.UUID(
                payload["conversationId"]
            )

            content = payload.get("content", "")

            sender_id = uuid.UUID(user_id)

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
        manager.disconnect(user_id, websocket)