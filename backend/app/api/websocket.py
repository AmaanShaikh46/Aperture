import json
import logging
import uuid
from json import JSONDecodeError

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from sqlalchemy import select

from app.core.security import verify_access_token
from app.database.database import AsyncSessionLocal
from app.models.conversation_participants import ConversationParticipant
from app.services.connection_manager import manager
from app.services.message_service import create_message


router = APIRouter()
logger = logging.getLogger(__name__)
MAX_WEBSOCKET_FRAME_BYTES = 64 * 1024
MAX_MESSAGE_CHARACTERS = 10_000


async def _send_protocol_error(websocket: WebSocket, detail: str) -> None:
    try:
        await websocket.send_json({
            "type": "message.error",
            "payload": {"detail": detail},
        })
    except Exception:
        # The client may have disconnected while the error was being sent.
        pass


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    token = websocket.query_params.get("token")

    if not token:
        await websocket.close(code=1008)
        return

    try:
        user = await verify_access_token(token)
        user_id = str(user["id"])
        # Reject malformed IDs before registering a live connection.
        uuid.UUID(user_id)
    except HTTPException as exc:
        close_code = 1008 if exc.status_code == 401 else 1011
        await websocket.close(code=close_code)
        return
    except (KeyError, ValueError, TypeError):
        await websocket.close(code=1008)
        return

    await manager.connect(user_id, websocket)

    try:
        while True:
            try:
                raw_data = await websocket.receive_text()
            except WebSocketDisconnect:
                raise

            if len(raw_data.encode("utf-8")) > MAX_WEBSOCKET_FRAME_BYTES:
                await _send_protocol_error(
                    websocket, "WebSocket event exceeds the 64 KB limit."
                )
                continue

            try:
                data = json.loads(raw_data)
            except (JSONDecodeError, UnicodeError):
                await _send_protocol_error(websocket, "Invalid JSON event.")
                continue

            if not isinstance(data, dict):
                await _send_protocol_error(
                    websocket, "WebSocket event must be a JSON object."
                )
                continue

            if data.get("type") != "message.send":
                # Other event types are not supported by this backend handler yet.
                continue

            payload = data.get("payload")
            if not isinstance(payload, dict):
                await _send_protocol_error(
                    websocket, "Message payload must be a JSON object."
                )
                continue

            try:
                conversation_id = uuid.UUID(payload.get("conversationId", ""))
            except (ValueError, TypeError, AttributeError):
                await _send_protocol_error(websocket, "Invalid conversation ID.")
                continue

            content = payload.get("content")
            if not isinstance(content, str):
                await _send_protocol_error(websocket, "Message content must be text.")
                continue

            if len(content) > MAX_MESSAGE_CHARACTERS:
                await _send_protocol_error(
                    websocket, "Messages cannot exceed 10,000 characters."
                )
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
                            ConversationParticipant.conversation_id == conversation_id
                        )
                    )
                    participant_ids = result.scalars().all()

            except HTTPException as exc:
                await _send_protocol_error(websocket, str(exc.detail))
                continue
            except Exception:
                # A transient persistence failure must not terminate the entire
                # WebSocket receive loop or leak internal exception details.
                logger.exception(
                    "Message persistence failed for conversation %s",
                    conversation_id,
                )
                await _send_protocol_error(
                    websocket, "Could not send the message right now. Please retry."
                )
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
                try:
                    await manager.send_to_user(
                        str(participant_id),
                        {"type": "message.new", "payload": message_data},
                    )
                except Exception:
                    # Persistence already succeeded. A fanout failure must not
                    # pretend the saved message failed.
                    # ConnectionManager logs/drops broken sockets as needed.
                    continue

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(user_id, websocket)
