"""Friend-gated presence snapshots and WebSocket fan-out."""
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.friendship import Friendship
from app.models.profiles import Profile
from app.services.connection_manager import manager

logger = logging.getLogger(__name__)


def _friend_ids_for(user_id: uuid.UUID, friendships: list[Friendship]) -> list[str]:
    result = []
    for friendship in friendships:
        other = friendship.user_high_id if friendship.user_low_id == user_id else friendship.user_low_id
        result.append(str(other))
    return result


async def get_presence_snapshot(db: AsyncSession, viewer_id: uuid.UUID, target_id: uuid.UUID) -> dict:
    if viewer_id == target_id:
        raise PermissionError("You cannot query your own friend presence.")
    low_id, high_id = sorted((viewer_id, target_id), key=lambda value: value.int)
    friendship = await db.execute(
        select(Friendship.id).where(
            Friendship.user_low_id == low_id, Friendship.user_high_id == high_id
        )
    )
    if friendship.scalar_one_or_none() is None:
        raise PermissionError("Presence is only available to accepted friends.")

    result = await db.execute(select(Profile).where(Profile.id == target_id))
    profile = result.scalar_one_or_none()
    if profile is None or not profile.share_last_seen:
        return {"userId": str(target_id), "presence": "hidden", "lastSeen": None}

    online = bool(manager.active_connections.get(str(target_id)))
    return {
        "userId": str(target_id),
        "presence": "online" if online else "offline",
        "lastSeen": None if online or profile.last_seen_at is None else profile.last_seen_at.isoformat(),
    }


async def broadcast_presence(db: AsyncSession, user_id: uuid.UUID, *, force_hidden: bool = False) -> None:
    """Notify accepted friends of current status, never sending data when hidden."""
    profile_result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = profile_result.scalar_one_or_none()
    if profile is None:
        return
    friends_result = await db.execute(
        select(Friendship).where(
            (Friendship.user_low_id == user_id) | (Friendship.user_high_id == user_id)
        )
    )
    friends = _friend_ids_for(user_id, list(friends_result.scalars().all()))
    hidden = force_hidden or not profile.share_last_seen
    online = bool(manager.active_connections.get(str(user_id)))
    if hidden:
        payload = {"userId": str(user_id), "presence": "hidden", "lastSeen": None}
        event_type = "presence.offline"
    elif online:
        payload = {"userId": str(user_id), "presence": "online", "lastSeen": None}
        event_type = "presence.online"
    else:
        payload = {
            "userId": str(user_id), "presence": "offline",
            "lastSeen": profile.last_seen_at.isoformat() if profile.last_seen_at else None,
        }
        event_type = "presence.offline"
    for friend_id in friends:
        try:
            await manager.send_to_user(friend_id, {"type": event_type, "payload": payload})
        except Exception:
            logger.exception("Presence fan-out failed for friend %s", friend_id)


async def persist_last_seen(db: AsyncSession, user_id: uuid.UUID) -> datetime:
    timestamp = datetime.now(timezone.utc)
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        raise LookupError("Profile not found while saving last-seen timestamp.")
    profile.last_seen_at = timestamp
    await db.commit()
    return timestamp
