import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.call_session import CallSession
from app.models.profiles import Profile
from app.services.connection_manager import manager
from app.services.friendship_service import require_friends

router = APIRouter()
logger = logging.getLogger(__name__)
TERMINAL_STATUSES = {"rejected", "completed", "cancelled", "missed"}
ACTIVE_STATUSES = {"ringing", "accepted"}


async def _lock_call_participants(
    db: AsyncSession,
    *user_ids: uuid.UUID,
) -> None:
    """Serialize call creation for shared participants until transaction end."""
    for participant_id in sorted(set(user_ids), key=lambda value: value.int):
        result = await db.execute(
            select(Profile.id)
            .where(Profile.id == participant_id)
            .with_for_update()
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Call participant not found")


def _name(profile: Profile | None) -> str:
    if profile is None:
        return "Unknown"
    return (profile.display_name or profile.username or "Unknown").strip() or "Unknown"


def _duration(call: CallSession) -> int:
    if not call.accepted_at:
        return 0
    end_time = call.ended_at or datetime.now(timezone.utc)
    start_time = call.accepted_at
    if start_time.tzinfo is None:
        start_time = start_time.replace(tzinfo=timezone.utc)
    if end_time.tzinfo is None:
        end_time = end_time.replace(tzinfo=timezone.utc)
    return max(0, int((end_time - start_time).total_seconds()))


def _serialize_call(
    call: CallSession,
    current_user_id: uuid.UUID,
    caller: Profile | None,
    callee: Profile | None,
) -> dict:
    outgoing = call.caller_id == current_user_id
    other = callee if outgoing else caller
    return {
        "id": str(call.id),
        "callerId": str(call.caller_id),
        "calleeId": str(call.callee_id),
        "callType": call.call_type,
        "displayName": _name(other),
        "avatarUrl": other.avatar_url if other else None,
        "direction": "outgoing" if outgoing else "incoming",
        "status": call.status,
        "startedAt": call.created_at.isoformat() if call.created_at else None,
        "acceptedAt": call.accepted_at.isoformat() if call.accepted_at else None,
        "endedAt": call.ended_at.isoformat() if call.ended_at else None,
        "duration": _duration(call),
    }


async def _profile(db: AsyncSession, user_id: uuid.UUID) -> Profile | None:
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    return result.scalar_one_or_none()


async def _get_call_for_user(
    db: AsyncSession,
    call_id: uuid.UUID,
    current_user_id: uuid.UUID,
    *,
    lock: bool = False,
) -> CallSession:
    statement = select(CallSession).where(CallSession.id == call_id)
    if lock:
        statement = statement.with_for_update()
    result = await db.execute(statement)
    call = result.scalar_one_or_none()
    if call is None or current_user_id not in (call.caller_id, call.callee_id):
        # Do not disclose whether another user's call ID exists.
        raise HTTPException(status_code=404, detail="Call not found")
    return call


async def _notify(user_id: uuid.UUID, event_type: str, payload: dict) -> None:
    try:
        await manager.send_to_user(
            str(user_id),
            {"type": event_type, "payload": payload},
        )
    except Exception:
        # The call state is persisted first. Socket delivery is best-effort.
        logger.exception("Could not deliver %s notification", event_type)


@router.get("/calls")
async def list_calls(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    caller = aliased(Profile)
    callee = aliased(Profile)
    result = await db.execute(
        select(CallSession, caller, callee)
        .join(caller, caller.id == CallSession.caller_id)
        .join(callee, callee.id == CallSession.callee_id)
        .where(
            or_(
                CallSession.caller_id == current_user_id,
                CallSession.callee_id == current_user_id,
            )
        )
        .order_by(CallSession.created_at.desc(), CallSession.id.desc())
        .limit(100)
    )
    return [
        _serialize_call(call, current_user_id, caller_profile, callee_profile)
        for call, caller_profile, callee_profile in result.all()
    ]


@router.get("/calls/{call_id}")
async def get_call(
    call_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    call = await _get_call_for_user(db, call_id, current_user_id)
    caller = await _profile(db, call.caller_id)
    callee = await _profile(db, call.callee_id)
    return _serialize_call(call, current_user_id, caller, callee)


@router.post("/calls")
async def create_call(
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    caller_id = uuid.UUID(current_user["id"])
    try:
        callee_id = uuid.UUID(str(data.get("userId", "")))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="A valid userId is required")

    if callee_id == caller_id:
        raise HTTPException(status_code=400, detail="You cannot call yourself")

    call_type = data.get("callType", "audio")
    if call_type not in ("audio", "video"):
        raise HTTPException(status_code=400, detail="callType must be audio or video")

    caller_profile = await _profile(db, caller_id)
    callee_profile = await _profile(db, callee_id)
    if caller_profile is None:
        raise HTTPException(status_code=404, detail="Your profile was not found")
    if callee_profile is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Calls follow the same mutual-friend policy as direct messages.
    await require_friends(db, caller_id, callee_id)
    await _lock_call_participants(db, caller_id, callee_id)

    in_progress = await db.execute(
        select(CallSession.id).where(
            or_(
                CallSession.caller_id.in_([caller_id, callee_id]),
                CallSession.callee_id.in_([caller_id, callee_id]),
            ),
            CallSession.status.in_(ACTIVE_STATUSES),
        ).limit(1)
    )
    if in_progress.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="You already have an active call")

    call = CallSession(
        caller_id=caller_id,
        callee_id=callee_id,
        call_type=call_type,
        status="ringing",
    )
    db.add(call)
    try:
        await db.commit()
        await db.refresh(call)
    except Exception:
        await db.rollback()
        logger.exception("Failed to create call session")
        raise HTTPException(status_code=500, detail="Could not start the call")

    # A friend may be removed immediately after the call row is committed.
    # Reacquire the friendship lock, then the call-row lock, before notifying the
    # recipient. Sending while those locks are held guarantees the incoming
    # event cannot be delivered after a concurrent remove-friend event.
    try:
        await require_friends(db, caller_id, callee_id)
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        latest_result = await db.execute(
            select(CallSession).where(CallSession.id == call.id).with_for_update()
        )
        latest_call = latest_result.scalar_one_or_none()
        if latest_call is not None and latest_call.status == "ringing":
            latest_call.status = "cancelled"
            latest_call.ended_at = datetime.now(timezone.utc)
            latest_call.ended_by = caller_id
            await db.commit()
        else:
            await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Friendship ended before the call could be delivered.",
        ) from exc

    latest_result = await db.execute(
        select(CallSession).where(CallSession.id == call.id).with_for_update()
    )
    latest_call = latest_result.scalar_one_or_none()
    if latest_call is None or latest_call.status != "ringing":
        await db.rollback()
        raise HTTPException(status_code=409, detail="This call is no longer active.")

    await _notify(
        callee_id,
        "call.incoming",
        {
            "callId": str(latest_call.id),
            "callerId": str(caller_id),
            "displayName": _name(caller_profile),
            "avatarUrl": caller_profile.avatar_url,
            "callType": latest_call.call_type,
            "startedAt": latest_call.created_at.isoformat(),
        },
    )
    await db.commit()
    return _serialize_call(latest_call, caller_id, caller_profile, callee_profile)


@router.post("/calls/{call_id}/accept")
async def accept_call(
    call_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    # Read without locking first so we can lock resources in a consistent
    # order: friendship row, then call row. The final locked read below
    # revalidates call ownership and status against concurrent accept/reject/end.
    call = await _get_call_for_user(db, call_id, current_user_id)
    if current_user_id != call.callee_id:
        raise HTTPException(status_code=403, detail="Only the recipient can accept a call")
    if call.status != "ringing":
        raise HTTPException(status_code=409, detail="This call is no longer ringing")

    try:
        await require_friends(db, call.caller_id, call.callee_id)
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        # No friendship exists. Lock the call only after the friendship check
        # so this path cannot deadlock against remove_friend (friendship -> call).
        call = await _get_call_for_user(db, call_id, current_user_id, lock=True)
        if call.status == "ringing":
            call.status = "rejected"
            call.ended_at = datetime.now(timezone.utc)
            call.ended_by = current_user_id
            await db.commit()
            await _notify(
                call.caller_id,
                "call.rejected",
                {"callId": str(call.id), "reason": "friendship_required"},
            )
            raise
        raise HTTPException(status_code=409, detail="This call is no longer ringing") from exc

    # Friendship is locked for the rest of this transaction. A concurrent
    # removal waits until acceptance commits, then ends the accepted call.
    call = await _get_call_for_user(db, call_id, current_user_id, lock=True)
    if current_user_id != call.callee_id:
        raise HTTPException(status_code=403, detail="Only the recipient can accept a call")
    if call.status != "ringing":
        raise HTTPException(status_code=409, detail="This call is no longer ringing")

    profile = await _profile(db, current_user_id)
    call.status = "accepted"
    call.accepted_at = datetime.now(timezone.utc)
    await db.commit()

    await _notify(
        call.caller_id,
        "call.accepted",
        {
            "callId": str(call.id),
            "calleeId": str(current_user_id),
            "displayName": _name(profile),
            "avatarUrl": profile.avatar_url if profile else None,
            "callType": call.call_type,
        },
    )
    return {"success": True, "callId": str(call.id), "status": call.status}


@router.post("/calls/{call_id}/reject")
async def reject_call(
    call_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    call = await _get_call_for_user(db, call_id, current_user_id, lock=True)
    if current_user_id != call.callee_id:
        raise HTTPException(status_code=403, detail="Only the recipient can reject a call")
    if call.status != "ringing":
        raise HTTPException(status_code=409, detail="This call is no longer ringing")

    call.status = "rejected"
    call.ended_at = datetime.now(timezone.utc)
    call.ended_by = current_user_id
    await db.commit()
    await _notify(call.caller_id, "call.rejected", {"callId": str(call.id)})
    return {"success": True, "callId": str(call.id), "status": call.status}


@router.post("/calls/{call_id}/end")
async def end_call(
    call_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    call = await _get_call_for_user(db, call_id, current_user_id, lock=True)
    if call.status in TERMINAL_STATUSES:
        return {"success": True, "callId": str(call.id), "status": call.status}
    if call.status not in ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="This call cannot be ended")

    call.status = "cancelled" if call.status == "ringing" and current_user_id == call.caller_id else "completed"
    call.ended_at = datetime.now(timezone.utc)
    call.ended_by = current_user_id
    other_user_id = call.callee_id if current_user_id == call.caller_id else call.caller_id
    await db.commit()
    await _notify(
        other_user_id,
        "call.ended",
        {"callId": str(call.id), "status": call.status, "endedBy": str(current_user_id)},
    )
    return {"success": True, "callId": str(call.id), "status": call.status}
