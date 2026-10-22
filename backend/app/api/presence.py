"""Authenticated, accepted-friend-only presence API."""
import uuid
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.profiles import Profile
from app.services.connection_manager import manager
from app.services.presence_service import broadcast_presence, get_presence_snapshot

router = APIRouter(prefix="/api/presence", tags=["Presence"])
logger = logging.getLogger(__name__)


class PresencePreferenceUpdate(BaseModel):
    shareLastSeen: bool


@router.get("/settings")
async def get_presence_settings(
    current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    user_id = uuid.UUID(current_user["id"])
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return {"shareLastSeen": profile.share_last_seen}


@router.patch("/settings")
async def update_presence_settings(
    update: PresencePreferenceUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["id"])
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found.")
    profile.share_last_seen = update.shareLastSeen
    try:
        await db.commit()
        await db.refresh(profile)
    except Exception as exc:
        await db.rollback()
        logger.exception("Could not persist presence preference for %s", user_id)
        raise HTTPException(status_code=500, detail="Could not update presence settings.") from exc
    try:
        await broadcast_presence(db, user_id, force_hidden=not profile.share_last_seen)
    except Exception:
        # The preference is already persisted and will be enforced on every
        # subsequent snapshot/event. Keep the API result truthful if fan-out fails.
        logger.exception("Presence preference saved but fan-out failed for %s", user_id)
    return {"shareLastSeen": profile.share_last_seen}


@router.get("/{user_id}")
async def get_presence(
    user_id: str, current_user: dict = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    try:
        target_id = uuid.UUID(user_id)
        viewer_id = uuid.UUID(current_user["id"])
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="Presence not found.")
    try:
        return await get_presence_snapshot(db, viewer_id, target_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
