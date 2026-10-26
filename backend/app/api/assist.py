import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.calls import ACTIVE_STATUSES, _lock_call_participants, _notify, _name
from app.core.security import get_current_user
from app.database.database import get_db
from app.models.assist_command import AssistCommand
from app.models.call_session import CallSession
from app.models.conversation_participants import ConversationParticipant
from app.models.conversations import Conversation
from app.models.friendship import Friendship
from app.models.message import Message
from app.models.message_receipt import MessageReceipt
from app.models.profiles import Profile
from app.services.connection_manager import manager
from app.services.friendship_service import canonical_pair, require_friends
from app.services.assist_parser import parse_assist_transcript

router = APIRouter()
logger = logging.getLogger(__name__)


class AssistCommandRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=12000)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    # Handle legacy/SQLite-naive timestamps defensively.
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _command_expired(command: AssistCommand, now: datetime) -> bool:
    return _as_utc(command.expires_at) <= now


def _pending_response(
    command: AssistCommand,
    recipient: Profile,
) -> dict:
    recipient_name = recipient.display_name or recipient.username or "Unknown"
    if command.intent == "SEND_MESSAGE":
        spoken = (
            f"Send this message to {recipient_name}: "
            f"{command.message_content}?"
        )
    else:
        spoken = f"Call {recipient_name}?"

    return {
        "commandId": str(command.id),
        "state": "CONFIRMING",
        "intent": command.intent,
        "recipient": {
            "id": str(recipient.id),
            "displayName": recipient_name,
            "username": recipient.username,
        },
        "message": command.message_content,
        # These are transparent heuristic scores, not calibrated probabilities.
        "confidence": min(
            getattr(command, "_intent_confidence", 0.99),
            getattr(command, "_recipient_match_score", 1.0),
        ),
        "intentConfidence": getattr(command, "_intent_confidence", 0.99),
        "recipientMatchScore": getattr(command, "_recipient_match_score", 1.0),
        "confidenceMethod": "rule-based intent heuristic and edit-distance recipient similarity; not calibrated probabilities",
        "risk": "high" if command.intent == "CALL_CONTACT" else "medium",
        "confirmationRequired": True,
        "spokenResponse": spoken,
    }


async def _get_owned_command(
    db: AsyncSession,
    command_id: uuid.UUID,
    owner_id: uuid.UUID,
    *,
    lock: bool = True,
) -> AssistCommand:
    query = select(AssistCommand).where(
        AssistCommand.id == command_id,
        AssistCommand.owner_id == owner_id,
    )
    if lock:
        query = query.with_for_update()

    result = await db.execute(query)
    command = result.scalar_one_or_none()
    if command is None:
        # Do not disclose whether another user's command exists.
        raise HTTPException(status_code=404, detail="Assist command not found")
    return command


async def _existing_success(
    db: AsyncSession,
    command: AssistCommand,
) -> dict:
    result_id = None
    response = {
        "commandId": str(command.id),
        "state": "SUCCESS",
        "intent": command.intent,
        "spokenResponse": "The action was already completed.",
    }

    if command.intent == "SEND_MESSAGE":
        result = await db.execute(
            select(Message).where(Message.assist_command_id == command.id)
        )
        message = result.scalar_one_or_none()
        if message is not None:
            response.update({
                "messageId": str(message.id),
                "conversationId": str(message.conversation_id),
                "spokenResponse": "Your message has already been sent.",
            })
    elif command.intent == "CALL_CONTACT":
        result = await db.execute(
            select(CallSession).where(
                CallSession.assist_command_id == command.id
            )
        )
        call = result.scalar_one_or_none()
        if call is not None:
            response.update({
                "callId": str(call.id),
                "status": call.status,
                "spokenResponse": "Your call has already been started.",
            })

    return response


@router.post("/command")
async def submit_assist_command(
    data: AssistCommandRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    owner_id = uuid.UUID(current_user["id"])

    friendship_result = await db.execute(
        select(Friendship).where(
            or_(
                Friendship.user_low_id == owner_id,
                Friendship.user_high_id == owner_id,
            )
        )
    )
    friendships = friendship_result.scalars().all()

    friend_ids = {
        friendship.user_high_id
        if friendship.user_low_id == owner_id
        else friendship.user_low_id
        for friendship in friendships
    }

    friends = []
    if friend_ids:
        profile_result = await db.execute(
            select(Profile).where(Profile.id.in_(friend_ids))
        )
        friends = profile_result.scalars().all()

    parsed = parse_assist_transcript(data.transcript, friends)
    if parsed.command is None:
        return {
            "commandId": None,
            "state": "ERROR",
            "intent": None,
            "recipient": None,
            "message": None,
            "confidence": 0.0,
            "intentConfidence": 0.0,
            "recipientMatchScore": 0.0,
            "confidenceMethod": "No action parsed; no confidence score available",
            "risk": "none",
            "clarificationOptions": [
                {
                    "recipientId": str(option.recipient_id),
                    "username": option.username,
                    "displayName": option.display_name,
                    "transcript": option.transcript,
                }
                for option in parsed.clarification_options
            ],
            "confirmationRequired": False,
            "spokenResponse": parsed.clarification
            or "I couldn't understand that request. No action was taken.",
        }

    command_data = parsed.command
    recipient_id = uuid.UUID(str(command_data.recipient_id))
    now = _utc_now()

    command = AssistCommand(
        owner_id=owner_id,
        transcript=data.transcript.strip(),
        intent=command_data.intent,
        state="pending_confirmation",
        recipient_id=recipient_id,
        message_content=command_data.message,
        expires_at=now + timedelta(minutes=5),
    )

    try:
        db.add(command)
        await db.commit()
        await db.refresh(command)
    except Exception:
        await db.rollback()
        raise

    recipient = next(
        (friend for friend in friends if friend.id == recipient_id),
        None,
    )
    if recipient is None:
        # This should be rare, but don't return a confirmation whose recipient
        # is no longer present among the current friendship profiles.
        return {
            "commandId": str(command.id),
            "state": "ERROR",
            "intent": None,
            "recipient": None,
            "message": None,
            "confidence": 0.0,
            "risk": "high",
            "confirmationRequired": False,
            "spokenResponse": "I couldn't verify that friend. No action was taken.",
        }

    command._intent_confidence = command_data.intent_confidence
    command._recipient_match_score = command_data.recipient_match_score
    return _pending_response(command, recipient)


async def _notify_incoming_call_or_cancel(
    db: AsyncSession,
    command,
    call,
    owner_id: uuid.UUID,
    caller_profile: Profile,
) -> bool:
    """Notify the recipient, or persist a terminal state if delivery raises."""
    recipient_id = command.recipient_id
    command_id = str(command.id)
    call_id = str(call.id)
    incoming_payload = {
        "callId": call_id,
        "callerId": str(owner_id),
        "displayName": _name(caller_profile),
        "avatarUrl": caller_profile.avatar_url,
        "callType": call.call_type,
        "startedAt": call.created_at.isoformat(),
    }

    try:
        await _notify(recipient_id, "call.incoming", incoming_payload)
        return True
    except Exception:
        logger.exception(
            "Assist incoming-call notification failed for command %s; cancelling call",
            command_id,
        )

    # The call was committed before notification. Persist cancellation and the
    # failed command together so a failed WebSocket send cannot leave a ringing
    # call attached to an indefinitely executing command.
    ended_at = _utc_now()
    call.status = "cancelled"
    call.ended_at = ended_at
    call.ended_by = owner_id
    command.state = "failed"
    command.updated_at = ended_at

    ended_payload = {
        "callId": call_id,
        "status": "cancelled",
        "endedBy": str(owner_id),
        "reason": "incoming_notification_failed",
    }

    await db.commit()

    # The original event may have reached a client before the send failed.
    # Best-effort end events prevent a delivered incoming prompt lingering.
    for target_user_id in {owner_id, recipient_id}:
        try:
            await _notify(target_user_id, "call.ended", ended_payload)
        except Exception:
            logger.exception(
                "Could not deliver call-ended event after notification failure "
                "for call %s to user %s",
                call_id,
                target_user_id,
            )

    return False


@router.post("/{command_id}/confirm")
async def confirm_assist_command(
    command_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    owner_id = uuid.UUID(current_user["id"])
    command = await _get_owned_command(db, command_id, owner_id)
    now = _utc_now()

    # Success is idempotent: a repeated confirmation returns the original
    # resource rather than executing the real-world action again.
    if command.state == "succeeded":
        response = await _existing_success(db, command)
        await db.rollback()
        return response

    if command.state == "executing":
        # Recover the call committed before notification. Never create a new
        # CallSession for an executing command.
        try:
            existing_result = await db.execute(
                select(CallSession).where(
                    CallSession.assist_command_id == command.id
                )
            )
            existing_call = existing_result.scalar_one_or_none()

            if existing_call is None:
                command.state = "failed"
                command.updated_at = now
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": (
                        "The call record could not be recovered. "
                        "Please check your call history."
                    ),
                }

            if existing_call.status != "ringing":
                command.state = "succeeded"
                command.updated_at = now
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "SUCCESS",
                    "intent": command.intent,
                    "callId": str(existing_call.id),
                    "status": existing_call.status,
                    "spokenResponse": (
                        "The call was already started and is no longer ringing."
                    ),
                }

            if command.recipient_id is None:
                existing_call.status = "cancelled"
                existing_call.ended_at = now
                existing_call.ended_by = owner_id
                command.state = "failed"
                command.updated_at = now
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": "The recipient is no longer available.",
                }

            await require_friends(db, owner_id, command.recipient_id)

            profiles_result = await db.execute(
                select(Profile).where(
                    Profile.id.in_([owner_id, command.recipient_id])
                )
            )
            profiles = {
                profile.id: profile
                for profile in profiles_result.scalars().all()
            }
            caller_profile = profiles.get(owner_id)
            recipient = profiles.get(command.recipient_id)

            latest_result = await db.execute(
                select(CallSession)
                .where(CallSession.id == existing_call.id)
                .with_for_update()
            )
            latest_call = latest_result.scalar_one_or_none()

            if latest_call is None:
                command.state = "failed"
                command.updated_at = _utc_now()
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": "The call record could not be recovered.",
                }

            if latest_call.status != "ringing":
                command.state = "succeeded"
                command.updated_at = _utc_now()
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "SUCCESS",
                    "intent": command.intent,
                    "callId": str(latest_call.id),
                    "status": latest_call.status,
                    "spokenResponse": (
                        "The call was already started and is no longer ringing."
                    ),
                }

            if caller_profile is None or recipient is None:
                latest_call.status = "cancelled"
                latest_call.ended_at = _utc_now()
                latest_call.ended_by = owner_id
                command.state = "failed"
                command.updated_at = _utc_now()
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": "A call participant is no longer available.",
                }

            if not await _notify_incoming_call_or_cancel(
                db, command, latest_call, owner_id, caller_profile
            ):
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": (
                        "I couldn't notify your friend, so I cancelled the call. "
                        "Please try again."
                    ),
                }

            command.state = "succeeded"
            command.updated_at = _utc_now()
            await db.commit()
            return {
                "commandId": str(command.id),
                "state": "SUCCESS",
                "intent": command.intent,
                "callId": str(latest_call.id),
                "status": latest_call.status,
                "spokenResponse": (
                    f"Calling {recipient.display_name or recipient.username or 'your friend'}."
                ),
            }

        except HTTPException as exc:
            await db.rollback()
            if exc.status_code != 403:
                raise

            # The friendship was revoked during recovery. Cancel only the
            # existing ringing call; do not create or notify a new one.
            try:
                latest_result = await db.execute(
                    select(CallSession)
                    .where(CallSession.assist_command_id == command.id)
                    .with_for_update()
                )
                latest_call = latest_result.scalar_one_or_none()
                if latest_call is not None and latest_call.status == "ringing":
                    latest_call.status = "cancelled"
                    latest_call.ended_at = _utc_now()
                    latest_call.ended_by = owner_id
                command.state = "failed"
                command.updated_at = _utc_now()
                await db.commit()
            except Exception:
                await db.rollback()
                raise

            return {
                "commandId": str(command.id),
                "state": "ERROR",
                "spokenResponse": (
                    "The friendship ended before the call could be delivered. "
                    "No call was placed."
                ),
            }
        except Exception:
            await db.rollback()
            logger.exception(
                "Assist call recovery failed for command %s", command_id
            )
            raise HTTPException(
                status_code=500,
                detail=(
                    "Call recovery failed. Please check your call status "
                    "before trying again."
                ),
            )

    if command.state != "pending_confirmation":
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"This command cannot be confirmed from state '{command.state}'.",
        )

    if _command_expired(command, now):
        command.state = "expired"
        command.updated_at = now
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail="This confirmation has expired. Please submit the request again.",
        )

    if command.recipient_id is None:
        command.state = "failed"
        command.updated_at = now
        await db.commit()
        raise HTTPException(status_code=409, detail="The recipient is no longer available.")

    try:
        # Lock order: friendship, participant profiles, then call rows.
        # Keep participant locks until the active-call check and insert commit.
        await require_friends(db, owner_id, command.recipient_id)

        recipient_result = await db.execute(
            select(Profile).where(Profile.id == command.recipient_id)
        )
        recipient = recipient_result.scalar_one_or_none()
        if recipient is None:
            raise HTTPException(status_code=404, detail="Recipient not found")

        if command.intent == "SEND_MESSAGE":
            content = command.message_content
            if not isinstance(content, str) or not content.strip():
                raise HTTPException(status_code=400, detail="Message content is empty")
            content = content.strip()
            if len(content) > 10000 or "\x00" in content:
                raise HTTPException(status_code=400, detail="Message content is invalid")

            low_id, high_id = canonical_pair(owner_id, command.recipient_id)
            conversation_result = await db.execute(
                select(Conversation).where(
                    Conversation.type == "direct",
                    Conversation.direct_user_low_id == low_id,
                    Conversation.direct_user_high_id == high_id,
                )
            )
            conversation = conversation_result.scalar_one_or_none()

            if conversation is None:
                conversation = Conversation(
                    type="direct",
                    direct_user_low_id=low_id,
                    direct_user_high_id=high_id,
                )
                db.add(conversation)
                await db.flush()

                db.add_all([
                    ConversationParticipant(
                        conversation_id=conversation.id,
                        user_id=owner_id,
                        role="member",
                    ),
                    ConversationParticipant(
                        conversation_id=conversation.id,
                        user_id=command.recipient_id,
                        role="member",
                    ),
                ])
                await db.flush()

            message = Message(
                conversation_id=conversation.id,
                sender_id=owner_id,
                assist_command_id=command.id,
                content=content,
                status="sent",
                receipt_tracking_enabled=True,
            )
            db.add(message)
            await db.flush()

            db.add(
                MessageReceipt(
                    message_id=message.id,
                    user_id=command.recipient_id,
                    read_at=None,
                )
            )

            conversation.updated_at = now
            command.conversation_id = conversation.id
            command.state = "succeeded"
            command.updated_at = now

            # Message, receipt, conversation changes, and command state commit
            # together. A rollback cannot leave a sent message with a pending
            # command.
            await db.commit()
            await db.refresh(message)

            message_data = {
                "id": str(message.id),
                "conversationId": str(message.conversation_id),
                "senderId": str(owner_id),
                "content": message.content,
                "createdAt": message.created_at.isoformat(),
                "status": message.status,
                "attachments": [],
            }

            try:
                await manager.send_to_user(
                    str(command.recipient_id),
                    {"type": "message.new", "payload": message_data},
                )
            except Exception:
                # Persistence succeeded; a WebSocket failure must not turn the
                # request into a reported failure or trigger a duplicate retry.
                logger.exception(
                    "Assist message %s persisted, but notification delivery failed",
                    message.id,
                )

            return {
                "commandId": str(command.id),
                "state": "SUCCESS",
                "intent": command.intent,
                "messageId": str(message.id),
                "conversationId": str(conversation.id),
                "spokenResponse": f"Message sent to {recipient.display_name or recipient.username or 'your friend'}.",
            }

        if command.intent == "CALL_CONTACT":
            await _lock_call_participants(db, owner_id, command.recipient_id)

            profiles_result = await db.execute(
                select(Profile).where(Profile.id.in_([owner_id, command.recipient_id]))
            )
            profiles = {profile.id: profile for profile in profiles_result.scalars().all()}
            caller_profile = profiles.get(owner_id)
            callee_profile = profiles.get(command.recipient_id)

            if caller_profile is None or callee_profile is None:
                raise HTTPException(status_code=404, detail="Call participant not found")

            in_progress = await db.execute(
                select(CallSession.id).where(
                    or_(
                        CallSession.caller_id.in_([owner_id, command.recipient_id]),
                        CallSession.callee_id.in_([owner_id, command.recipient_id]),
                    ),
                    CallSession.status.in_(ACTIVE_STATUSES),
                ).limit(1)
            )
            if in_progress.scalar_one_or_none() is not None:
                raise HTTPException(
                    status_code=409,
                    detail="You or your friend already have an active call.",
                )

            call = CallSession(
                caller_id=owner_id,
                callee_id=command.recipient_id,
                assist_command_id=command.id,
                call_type="audio",
                status="ringing",
            )
            db.add(call)
            command.state = "executing"
            command.updated_at = now

            # Persist the call before notifying, following the existing call
            # lifecycle. The command lock plus unique assist_command_id protect
            # against duplicate confirmations.
            await db.commit()
            await db.refresh(call)

            try:
                # Match the regular call endpoint's second friendship check and
                # call-row lock before sending the incoming notification.
                await require_friends(db, owner_id, command.recipient_id)
            except HTTPException as exc:
                if exc.status_code != 403:
                    raise

                latest_result = await db.execute(
                    select(CallSession)
                    .where(CallSession.id == call.id)
                    .with_for_update()
                )
                latest_call = latest_result.scalar_one_or_none()
                if latest_call is not None and latest_call.status == "ringing":
                    latest_call.status = "cancelled"
                    latest_call.ended_at = _utc_now()
                    latest_call.ended_by = owner_id

                command.state = "failed"
                command.updated_at = _utc_now()
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": "The friendship ended before the call could be delivered. No call was placed.",
                }

            latest_result = await db.execute(
                select(CallSession)
                .where(CallSession.id == call.id)
                .with_for_update()
            )
            latest_call = latest_result.scalar_one_or_none()
            if latest_call is None or latest_call.status != "ringing":
                command.state = "failed"
                command.updated_at = _utc_now()
                await db.commit()
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": "The call is no longer active.",
                }

            if not await _notify_incoming_call_or_cancel(
                db, command, latest_call, owner_id, caller_profile
            ):
                return {
                    "commandId": str(command.id),
                    "state": "ERROR",
                    "spokenResponse": (
                        "I couldn't notify your friend, so I cancelled the call. "
                        "Please try again."
                    ),
                }

            command.state = "succeeded"
            command.updated_at = _utc_now()
            await db.commit()

            return {
                "commandId": str(command.id),
                "state": "SUCCESS",
                "intent": command.intent,
                "callId": str(latest_call.id),
                "status": latest_call.status,
                "callType": latest_call.call_type,
                "displayName": recipient.display_name or recipient.username or "Unknown contact",
                "avatarUrl": recipient.avatar_url,
                "spokenResponse": (
                    f"{'Video' if latest_call.call_type == 'video' else 'Audio'} calling "
                    f"{recipient.display_name or recipient.username or 'your friend'}."
                ),
            }

        command.state = "failed"
        command.updated_at = now
        await db.commit()
        raise HTTPException(status_code=400, detail="Unsupported Assist intent")

    except HTTPException:
        # Preserve explicit error statuses while releasing any uncommitted work.
        await db.rollback()
        raise
    except Exception:
        await db.rollback()
        logger.exception("Assist command %s failed during confirmation", command_id)
        raise HTTPException(
            status_code=500,
            detail="The action could not be completed. Please check its status before retrying.",
        )


@router.post("/{command_id}/retry")
async def retry_assist_command(
    command_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    owner_id = uuid.UUID(current_user["id"])
    command = await _get_owned_command(db, command_id, owner_id)
    now = _utc_now()

    if command.state != "pending_confirmation":
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Only a pending confirmation can be retried.",
        )

    if _command_expired(command, now):
        command.state = "expired"
        command.updated_at = now
        await db.commit()
        raise HTTPException(
            status_code=409,
            detail="This confirmation has expired. Please submit the request again.",
        )

    if command.recipient_id is None:
        await db.rollback()
        raise HTTPException(status_code=409, detail="The recipient is no longer available.")

    recipient_result = await db.execute(
        select(Profile).where(Profile.id == command.recipient_id)
    )
    recipient = recipient_result.scalar_one_or_none()
    if recipient is None:
        await db.rollback()
        raise HTTPException(status_code=404, detail="Recipient not found")

    # The frontend starts a fresh recognition attempt after retry. Retire
    # this confirmation so it cannot remain pending as an orphaned command.
    command.state = "cancelled"
    command.updated_at = now
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {
        "commandId": str(command.id),
        "state": "CONFIRMING",
        "spokenResponse": "Ready to listen again.",
    }


@router.post("/{command_id}/cancel")
async def cancel_assist_command(
    command_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    owner_id = uuid.UUID(current_user["id"])
    command = await _get_owned_command(db, command_id, owner_id)

    if command.state == "cancelled":
        await db.rollback()
        return {"commandId": str(command.id), "state": "CANCELLED", "success": True}

    if command.state != "pending_confirmation":
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="This command can no longer be cancelled.",
        )

    command.state = "cancelled"
    command.updated_at = _utc_now()
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {"commandId": str(command.id), "state": "CANCELLED", "success": True}
