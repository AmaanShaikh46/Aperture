"""Friend requests and accepted-friendship endpoints."""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.call_session import CallSession
from app.models.friend_request import FriendRequest
from app.models.friendship import Friendship
from app.models.profiles import Profile
from app.services.connection_manager import manager
from app.services.friendship_service import canonical_pair

router = APIRouter(prefix="/users", tags=["Friendships"])
logger = logging.getLogger(__name__)


def _user_payload(profile: Profile, *, request_id: uuid.UUID | None = None, created_at=None) -> dict:
    payload = {
        "id": str(request_id) if request_id else None,
        "userId": str(profile.id),
        "username": profile.username,
        "displayName": profile.display_name or profile.username or "Unknown",
        "avatarUrl": profile.avatar_url,
    }
    if created_at is not None:
        payload["createdAt"] = created_at.isoformat() if hasattr(created_at, "isoformat") else created_at
    return payload


async def _profile_exists(db: AsyncSession, user_id: uuid.UUID) -> Profile | None:
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    return result.scalar_one_or_none()


@router.get("/friends")
async def list_friends(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    result = await db.execute(
        select(Profile)
        .join(
            Friendship,
            or_(
                and_(Friendship.user_low_id == current_user_id, Friendship.user_high_id == Profile.id),
                and_(Friendship.user_high_id == current_user_id, Friendship.user_low_id == Profile.id),
            ),
        )
        .where(Profile.id != current_user_id)
        .order_by(Profile.display_name, Profile.username)
    )
    return [
        {
            "id": str(profile.id),
            "username": profile.username,
            "displayName": profile.display_name or profile.username or "Unknown",
            "avatarUrl": profile.avatar_url,
        }
        for profile in result.scalars().all()
    ]


@router.get("/friend-requests")
async def list_friend_requests(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    incoming_result = await db.execute(
        select(FriendRequest, Profile)
        .join(Profile, Profile.id == FriendRequest.sender_id)
        .where(
            FriendRequest.recipient_id == current_user_id,
            FriendRequest.status == "pending",
        )
        .order_by(FriendRequest.created_at.desc())
    )
    outgoing_result = await db.execute(
        select(FriendRequest, Profile)
        .join(Profile, Profile.id == FriendRequest.recipient_id)
        .where(
            FriendRequest.sender_id == current_user_id,
            FriendRequest.status == "pending",
        )
        .order_by(FriendRequest.created_at.desc())
    )

    def serialize(rows):
        return [
            _user_payload(profile, request_id=request.id, created_at=request.created_at)
            for request, profile in rows
        ]

    return {
        "incoming": serialize(incoming_result.all()),
        "outgoing": serialize(outgoing_result.all()),
    }


@router.post("/friend-requests", status_code=status.HTTP_201_CREATED)
async def send_friend_request(
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sender_id = uuid.UUID(current_user["id"])
    try:
        recipient_id = uuid.UUID(str(data.get("userId", data.get("recipientId", ""))))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="A valid userId is required.")

    if sender_id == recipient_id:
        raise HTTPException(status_code=400, detail="You cannot send a friend request to yourself.")

    recipient = await _profile_exists(db, recipient_id)
    if recipient is None:
        raise HTTPException(status_code=404, detail="User not found.")

    low_id, high_id = canonical_pair(sender_id, recipient_id)

    # Lock the pair's request record before checking the friendship. If another
    # transaction is accepting a request, this makes us observe the committed
    # friendship instead of accidentally resetting the accepted request to pending.
    result = await db.execute(
        select(FriendRequest)
        .where(
            FriendRequest.user_low_id == low_id,
            FriendRequest.user_high_id == high_id,
        )
        .with_for_update()
    )
    request = result.scalar_one_or_none()

    friendship_result = await db.execute(
        select(Friendship.id)
        .where(
            Friendship.user_low_id == low_id,
            Friendship.user_high_id == high_id,
        )
        .with_for_update()
    )
    if friendship_result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="You are already friends with this user.")

    now = datetime.now(timezone.utc)

    if request is not None and request.status == "pending":
        if request.sender_id == sender_id:
            return {
                "id": str(request.id),
                "status": "pending",
                "message": "Your friend request is already pending.",
            }
        raise HTTPException(
            status_code=409,
            detail="This user has already sent you a friend request. Accept or reject it instead.",
        )

    if request is None:
        request = FriendRequest(
            user_low_id=low_id,
            user_high_id=high_id,
            sender_id=sender_id,
            recipient_id=recipient_id,
            status="pending",
            created_at=now,
            responded_at=None,
        )
        db.add(request)
    else:
        # Re-use the one pair record after a previous rejection/cancellation.
        request.sender_id = sender_id
        request.recipient_id = recipient_id
        request.status = "pending"
        request.created_at = now
        request.responded_at = None

    try:
        await db.commit()
        await db.refresh(request)
    except IntegrityError as exc:
        await db.rollback()
        logger.info("Concurrent friend request creation for user pair %s/%s", low_id, high_id)
        result = await db.execute(
            select(FriendRequest).where(
                FriendRequest.user_low_id == low_id,
                FriendRequest.user_high_id == high_id,
            )
        )
        existing = result.scalar_one_or_none()
        if existing is not None and existing.status == "pending" and existing.sender_id == sender_id:
            return {"id": str(existing.id), "status": "pending", "message": "Your friend request is already pending."}
        raise HTTPException(status_code=409, detail="A request already exists for this user.") from exc
    except Exception:
        await db.rollback()
        raise

    return {"id": str(request.id), "status": request.status, "message": "Friend request sent."}


@router.post("/friend-requests/{request_id}/accept")
async def accept_friend_request(
    request_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    result = await db.execute(
        select(FriendRequest).where(FriendRequest.id == request_id).with_for_update()
    )
    request = result.scalar_one_or_none()
    if request is None or request.recipient_id != current_user_id:
        raise HTTPException(status_code=404, detail="Friend request not found.")

    low_id, high_id = canonical_pair(request.sender_id, request.recipient_id)
    if request.status == "accepted":
        existing = await db.execute(
            select(Friendship.id).where(
                Friendship.user_low_id == low_id,
                Friendship.user_high_id == high_id,
            )
        )
        if existing.scalar_one_or_none() is not None:
            return {"success": True, "status": "accepted", "friendId": str(request.sender_id)}
    if request.status != "pending":
        raise HTTPException(status_code=409, detail="This friend request is no longer pending.")

    now = datetime.now(timezone.utc)
    # Database uniqueness makes accepting the same pair idempotent.
    await db.execute(
        pg_insert(Friendship)
        .values(user_low_id=low_id, user_high_id=high_id, created_at=now)
        .on_conflict_do_nothing(constraint="uq_friendships_user_pair")
    )
    request.status = "accepted"
    request.responded_at = now
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"success": True, "status": "accepted", "friendId": str(request.sender_id)}


@router.post("/friend-requests/{request_id}/reject")
async def reject_friend_request(
    request_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    result = await db.execute(
        select(FriendRequest).where(FriendRequest.id == request_id).with_for_update()
    )
    request = result.scalar_one_or_none()
    if request is None or request.recipient_id != current_user_id:
        raise HTTPException(status_code=404, detail="Friend request not found.")
    if request.status != "pending":
        raise HTTPException(status_code=409, detail="This friend request is no longer pending.")

    request.status = "rejected"
    request.responded_at = datetime.now(timezone.utc)
    await db.commit()
    return {"success": True, "status": "rejected"}


@router.delete("/friend-requests/{request_id}")
async def cancel_friend_request(
    request_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    result = await db.execute(
        select(FriendRequest).where(FriendRequest.id == request_id).with_for_update()
    )
    request = result.scalar_one_or_none()
    if request is None or request.sender_id != current_user_id:
        raise HTTPException(status_code=404, detail="Friend request not found.")
    if request.status != "pending":
        raise HTTPException(status_code=409, detail="This friend request is no longer pending.")
    request.status = "cancelled"
    request.responded_at = datetime.now(timezone.utc)
    await db.commit()
    return {"success": True, "status": "cancelled"}


@router.delete("/friends/{friend_id}")
async def remove_friend(
    friend_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])
    if friend_id == current_user_id:
        raise HTTPException(status_code=400, detail="You cannot remove yourself.")
    low_id, high_id = canonical_pair(current_user_id, friend_id)
    result = await db.execute(
        select(Friendship).where(
            Friendship.user_low_id == low_id,
            Friendship.user_high_id == high_id,
        ).with_for_update()
    )
    friendship = result.scalar_one_or_none()
    if friendship is None:
        return {"success": True, "removed": False}

    # Lock active call rows only after locking the friendship row. Call
    # acceptance and WebRTC signaling use the same lock order to avoid a
    # friendship/call-session deadlock during a concurrent remove/accept.
    active_result = await db.execute(
        select(CallSession)
        .where(
            or_(
                and_(
                    CallSession.caller_id == current_user_id,
                    CallSession.callee_id == friend_id,
                ),
                and_(
                    CallSession.caller_id == friend_id,
                    CallSession.callee_id == current_user_id,
                ),
            ),
            CallSession.status.in_(("ringing", "accepted")),
        )
        .with_for_update()
    )
    active_calls = active_result.scalars().all()
    ended_at = datetime.now(timezone.utc)
    ended_calls: list[tuple[CallSession, uuid.UUID]] = []

    for call in active_calls:
        was_ringing = call.status == "ringing"
        if was_ringing:
            call.status = "cancelled" if call.caller_id == current_user_id else "rejected"
        else:
            call.status = "completed"
        call.ended_at = ended_at
        call.ended_by = current_user_id
        other_user_id = call.callee_id if call.caller_id == current_user_id else call.caller_id
        ended_calls.append((call, other_user_id))

    await db.delete(friendship)
    await db.commit()

    # Persisted state is authoritative. Notify both clients best-effort so any
    # open call UI releases its media tracks immediately after the friendship
    # is removed. A notification failure must not undo the friendship change.
    for call, other_user_id in ended_calls:
        event = {
            "type": "call.ended",
            "payload": {
                "callId": str(call.id),
                "status": call.status,
                "endedBy": str(current_user_id),
                "reason": "friendship_removed",
            },
        }
        for target_user_id in {current_user_id, other_user_id}:
            try:
                await manager.send_to_user(str(target_user_id), event)
            except Exception:
                logger.exception(
                    "Friendship removal was saved, but call-end notification failed for call %s",
                    call.id,
                )

    return {
        "success": True,
        "removed": True,
        "endedCalls": len(ended_calls),
        "message": "Friend removed. Existing message history is preserved; new messages and calls are blocked, and active calls have been ended.",
    }
