import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from json import JSONDecodeError

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from sqlalchemy import or_, select

from app.core.security import verify_access_token
from app.database.database import AsyncSessionLocal
from app.models.conversation_participants import ConversationParticipant
from app.models.call_session import CallSession
from app.services.friendship_service import require_friends
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


async def _send_call_error(websocket: WebSocket, detail: str) -> None:
    try:
        await websocket.send_json({"type": "call.error", "payload": {"detail": detail}})
    except Exception:
        pass


async def _finish_calls_after_last_disconnect(user_id: str) -> None:
    """Close persisted call sessions when a user's last signaling socket is gone."""
    if manager.active_connections.get(user_id):
        return

    disconnected_user = uuid.UUID(user_id)
    notifications: list[tuple[str, dict]] = []
    try:
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(CallSession)
                .where(
                    or_(
                        CallSession.caller_id == disconnected_user,
                        CallSession.callee_id == disconnected_user,
                    ),
                    CallSession.status.in_(["ringing", "accepted"]),
                )
                .with_for_update()
            )
            calls = list(result.scalars().all())
            if not calls:
                return

            now = datetime.now(timezone.utc)
            for call in calls:
                disconnected_is_caller = call.caller_id == disconnected_user
                other_user_id = call.callee_id if disconnected_is_caller else call.caller_id
                old_status = call.status
                if old_status == "accepted":
                    call.status = "completed"
                    event_type = "call.ended"
                elif disconnected_is_caller:
                    call.status = "cancelled"
                    event_type = "call.ended"
                else:
                    call.status = "rejected"
                    event_type = "call.rejected"
                call.ended_at = now
                call.ended_by = disconnected_user
                notifications.append((str(other_user_id), {
                    "type": event_type,
                    "payload": {
                        "callId": str(call.id),
                        "status": call.status,
                        "endedBy": user_id,
                    },
                }))
            await db.commit()
    except Exception:
        logger.exception("Could not close calls after WebSocket disconnect for user %s", user_id)
        return

    for target_user_id, event in notifications:
        try:
            await manager.send_to_user(target_user_id, event)
        except Exception:
            logger.exception("Could not notify peer after call disconnect")


async def _handle_call_signal(
    websocket: WebSocket,
    user_id: str,
    event_type: str,
    payload: dict,
) -> None:
    """Authorize and relay a WebRTC offer, answer, or ICE candidate."""
    try:
        call_id = uuid.UUID(str(payload.get("callId", "")))
    except (ValueError, TypeError, AttributeError):
        await _send_call_error(websocket, "Invalid call ID.")
        return

    if event_type in {"call.offer", "call.answer"}:
        description_key = "offer" if event_type == "call.offer" else "answer"
        description = payload.get(description_key)
        expected_sdp_type = description_key
        if (
            not isinstance(description, dict)
            or description.get("type") != expected_sdp_type
            or not isinstance(description.get("sdp"), str)
            or not description["sdp"]
            or len(description["sdp"]) > 50_000
        ):
            await _send_call_error(websocket, f"Invalid WebRTC {description_key}.")
            return
        relay_value = {description_key: description}
    else:
        candidate = payload.get("candidate")
        if not isinstance(candidate, dict):
            await _send_call_error(websocket, "Invalid ICE candidate.")
            return
        allowed_keys = {"candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"}
        if set(candidate) - allowed_keys:
            await _send_call_error(websocket, "Invalid ICE candidate fields.")
            return
        candidate_line = candidate.get("candidate")
        if not isinstance(candidate_line, str) or len(candidate_line) > 8_192:
            await _send_call_error(websocket, "Invalid ICE candidate value.")
            return
        if candidate.get("sdpMid") is not None and not isinstance(candidate.get("sdpMid"), str):
            await _send_call_error(websocket, "Invalid ICE candidate media ID.")
            return
        if candidate.get("sdpMLineIndex") is not None and not isinstance(candidate.get("sdpMLineIndex"), int):
            await _send_call_error(websocket, "Invalid ICE candidate media index.")
            return
        relay_value = {"candidate": candidate}

    try:
        async with AsyncSessionLocal() as db:
            # Take the relationship lock before the call-row lock, matching
            # remove_friend and accept_call. This closes the race where stale
            # WebRTC offers/ICE candidates could be relayed during removal.
            result = await db.execute(select(CallSession).where(CallSession.id == call_id))
            call = result.scalar_one_or_none()
            if call is None or user_id not in {str(call.caller_id), str(call.callee_id)}:
                await _send_call_error(websocket, "Call not found.")
                return
            if call.status != "accepted":
                await _send_call_error(websocket, "Call is not active for signaling.")
                return

            caller_id = call.caller_id
            callee_id = call.callee_id
            try:
                await require_friends(db, caller_id, callee_id)
            except HTTPException as exc:
                if exc.status_code != 403:
                    raise
                # The friendship has gone. Only now lock/update the call row;
                # doing this after the friendship check avoids lock inversion.
                locked_result = await db.execute(
                    select(CallSession).where(CallSession.id == call_id).with_for_update()
                )
                locked_call = locked_result.scalar_one_or_none()
                ended_payload = None
                other_user_id = None
                if locked_call is not None and locked_call.status in {"ringing", "accepted"}:
                    locked_call.status = "completed"
                    locked_call.ended_at = datetime.now(timezone.utc)
                    locked_call.ended_by = uuid.UUID(user_id)
                    other_user_id = str(
                        locked_call.callee_id
                        if user_id == str(locked_call.caller_id)
                        else locked_call.caller_id
                    )
                    ended_payload = {
                        "callId": str(locked_call.id),
                        "status": locked_call.status,
                        "endedBy": user_id,
                        "reason": "friendship_required",
                    }
                    await db.commit()
                await _send_call_error(
                    websocket,
                    "Call ended because you are no longer friends.",
                )
                if ended_payload is not None and other_user_id is not None:
                    event = {"type": "call.ended", "payload": ended_payload}
                    for target_user_id in {user_id, other_user_id}:
                        try:
                            await manager.send_to_user(target_user_id, event)
                        except Exception:
                            logger.exception(
                                "Could not notify participant that an unauthorized call ended"
                            )
                return

            # The relationship row is now locked; serialize signaling against
            # the call's terminal-state transitions as well.
            locked_result = await db.execute(
                select(CallSession).where(CallSession.id == call_id).with_for_update()
            )
            call = locked_result.scalar_one_or_none()
            if call is None or user_id not in {str(call.caller_id), str(call.callee_id)}:
                await _send_call_error(websocket, "Call not found.")
                return
            if call.status != "accepted":
                await _send_call_error(websocket, "Call is not active for signaling.")
                return

            sender_is_caller = user_id == str(call.caller_id)
            if event_type == "call.offer" and not sender_is_caller:
                await _send_call_error(websocket, "Only the caller can send the initial offer.")
                return
            if event_type == "call.answer" and sender_is_caller:
                await _send_call_error(websocket, "Only the call recipient can answer the offer.")
                return

            recipient_id = str(call.callee_id if sender_is_caller else call.caller_id)
            relay_payload = {
                "callId": str(call.id),
                "fromUserId": user_id,
                **relay_value,
            }
            # Keep the friendship and call-row locks until relay completes. If
            # remove_friend wins the relationship lock, this handler observes
            # the removal and refuses to relay; if this handler wins, the signal
            # is delivered before remove_friend can announce call termination.
            try:
                await asyncio.wait_for(
                    manager.send_to_user(
                        recipient_id,
                        {"type": event_type, "payload": relay_payload},
                    ),
                    timeout=2.0,
                )
            except asyncio.TimeoutError:
                logger.warning("Call signaling delivery timed out for call %s", call_id)
                await _send_call_error(websocket, "Call signaling delivery timed out.")
                return
    except Exception:
        logger.exception("Call signaling lookup or relay failed")
        await _send_call_error(websocket, "Could not process call signaling right now.")


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

            event_type = data.get("type")
            payload = data.get("payload")
            if event_type in {"call.offer", "call.answer", "call.ice"}:
                if not isinstance(payload, dict):
                    await _send_call_error(websocket, "Call signaling payload must be a JSON object.")
                    continue
                await _handle_call_signal(websocket, user_id, event_type, payload)
                continue

            if event_type != "message.send":
                # Call lifecycle changes are REST operations; other unknown events are ignored.
                continue

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
                    # Resolve/authorize recipients before create_message commits.
                    # Avoid a post-commit query failure making an already-saved
                    # message look failed and causing the client to retry it.
                    result = await db.execute(
                        select(ConversationParticipant.user_id).where(
                            ConversationParticipant.conversation_id == conversation_id
                        )
                    )
                    participant_ids = result.scalars().all()
                    if sender_id not in participant_ids:
                        raise HTTPException(
                            status_code=404,
                            detail="Conversation not found",
                        )

                    message = await create_message(
                        db=db,
                        conversation_id=conversation_id,
                        sender_id=sender_id,
                        content=content,
                    )

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
                "receiptTrackingEnabled": bool(message.receipt_tracking_enabled),
                "receipts": [
                    {"userId": str(participant_id), "status": "unread", "readAt": None}
                    for participant_id in participant_ids
                    if participant_id != sender_id
                ],
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
        try:
            await _finish_calls_after_last_disconnect(user_id)
        except Exception:
            logger.exception("Call cleanup after WebSocket disconnect failed")
