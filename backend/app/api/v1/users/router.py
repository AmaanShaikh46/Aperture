"""Authenticated profile and user discovery endpoints."""

import asyncio
import logging
import uuid
from io import BytesIO
from datetime import datetime, timezone
from urllib.parse import unquote, urlparse

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.contacts import Contact
from app.models.profiles import Profile
from app.schemas.contact import ContactCreate
from app.schemas.user import ProfileUpdate, UserSearchResult
from app.services.storage_service import get_storage_client

from app.services.profile_events import broadcast_profile_updated

router = APIRouter(
    prefix="/users",
    tags=["Users"],
)

logger = logging.getLogger(__name__)

AVATAR_BUCKET = "aperture-avatars"
MAX_AVATAR_SIZE = 5 * 1024 * 1024
AVATAR_SOURCE_FORMATS = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
MAX_AVATAR_PIXELS = 20_000_000
MAX_AVATAR_DIMENSIONS = (512, 512)


def _normalize_avatar_image(file_bytes: bytes, content_type: str) -> bytes:
    """Decode and re-encode an image, removing metadata and bounding dimensions."""
    expected_format = AVATAR_SOURCE_FORMATS[content_type]

    try:
        with Image.open(BytesIO(file_bytes)) as source_image:
            if source_image.format != expected_format:
                raise HTTPException(
                    status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                    detail="The image content does not match its file type.",
                )
            width, height = source_image.size
            if width < 1 or height < 1 or width * height > MAX_AVATAR_PIXELS:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="Avatar image dimensions are too large.",
                )
            source_image.verify()

        with Image.open(BytesIO(file_bytes)) as source_image:
            image = ImageOps.exif_transpose(source_image)
            image.thumbnail(MAX_AVATAR_DIMENSIONS, Image.Resampling.LANCZOS)
            has_alpha = "A" in image.getbands() or "transparency" in image.info
            image = image.convert("RGBA" if has_alpha else "RGB")

            output = BytesIO()
            image.save(output, format="WEBP", quality=86, method=6)
            normalized_bytes = output.getvalue()
            if not normalized_bytes:
                raise ValueError("Image encoder returned no data.")
            return normalized_bytes
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError) as exc:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="The selected file is not a valid supported image.",
        ) from exc


def _profile_payload(profile: Profile, email: str | None = None) -> dict:
    """Return one stable camelCase profile shape for frontend consumers."""
    return {
        "id": str(profile.id),
        "username": profile.username,
        "displayName": profile.display_name,
        "avatarUrl": profile.avatar_url,
        "bio": profile.bio,
        "email": email,
        "createdAt": profile.created_at,
        "updatedAt": profile.updated_at,
    }


def _avatar_storage_path_from_url(url: str | None) -> str | None:
    """Return the object path only for URLs from our own public avatar bucket."""
    if not url:
        return None

    parsed = urlparse(url)
    marker = f"/storage/v1/object/public/{AVATAR_BUCKET}/"
    if marker not in parsed.path:
        return None

    path = parsed.path.split(marker, 1)[1]
    return unquote(path) if path else None


def _upload_avatar_object(path: str, file_bytes: bytes, content_type: str) -> str:
    storage = get_storage_client().storage.from_(AVATAR_BUCKET)
    storage.upload(
        path=path,
        file=file_bytes,
        file_options={
            "content-type": content_type,
            "upsert": "false",
            "cache-control": "3600",
        },
    )
    public_url = storage.get_public_url(path)
    if isinstance(public_url, dict):
        public_url = public_url.get("publicUrl") or public_url.get("public_url")
    if not isinstance(public_url, str) or not public_url:
        raise RuntimeError("Storage did not return a public avatar URL.")
    return public_url


def _remove_avatar_object(path: str) -> None:
    get_storage_client().storage.from_(AVATAR_BUCKET).remove([path])


async def _cleanup_avatar(path: str | None) -> None:
    if not path:
        return
    try:
        await asyncio.to_thread(_remove_avatar_object, path)
    except Exception:
        logger.exception("Could not clean up avatar object %s", path)


@router.get("/me")
async def get_my_profile(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["id"])
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = result.scalar_one_or_none()

    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Your profile record was not found.",
        )

    return {
        "authenticated": True,
        "profile": _profile_payload(profile, current_user.get("email")),
    }


@router.patch("/me")
async def update_my_profile(
    profile_data: ProfileUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["id"])
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = result.scalar_one_or_none()

    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Your profile record was not found.",
        )

    updates = profile_data.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Provide at least one profile field to update.",
        )

    requested_username = updates.get("username")
    if requested_username:
        username_result = await db.execute(
            select(Profile.id).where(
                func.lower(Profile.username) == requested_username,
                Profile.id != user_id,
            )
        )
        if username_result.scalar_one_or_none() is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="That username is already taken.",
            )

    for field_name, value in updates.items():
        setattr(profile, field_name, value)
    profile.updated_at = datetime.now(timezone.utc)

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        # Username is the only user-editable unique profile field.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That username is already taken.",
        ) from exc
    except Exception:
        await db.rollback()
        logger.exception("Unexpected error while updating profile %s", user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Profile update failed. Please try again.",
        )

    await db.refresh(profile)

    await broadcast_profile_updated(
        db=db,
        user_id=user_id,
        display_name=profile.display_name,
        username=profile.username,
        avatar_url=profile.avatar_url,
    )

    return {"profile": _profile_payload(profile, current_user.get("email"))}


@router.post("/me/avatar")
async def upload_my_avatar(
    file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["id"])
    result = await db.execute(select(Profile).where(Profile.id == user_id))
    profile = result.scalar_one_or_none()

    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Your profile record was not found.",
        )

    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in AVATAR_SOURCE_FORMATS:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Use a JPEG, PNG, or WebP image for your avatar.",
        )

    try:
        file_bytes = await file.read(MAX_AVATAR_SIZE + 1)
    finally:
        await file.close()

    if not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The selected image is empty.",
        )
    if len(file_bytes) > MAX_AVATAR_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Avatar images must be 5 MB or smaller.",
        )

    normalized_bytes = _normalize_avatar_image(file_bytes, content_type)
    content_type = "image/webp"
    storage_path = f"{user_id}/{uuid.uuid4().hex}.webp"
    old_storage_path = _avatar_storage_path_from_url(profile.avatar_url)

    try:
        public_url = await asyncio.to_thread(
            _upload_avatar_object,
            storage_path,
            normalized_bytes,
            content_type,
        )
    except Exception as exc:
        await _cleanup_avatar(storage_path)
        logger.exception("Avatar upload failed for user %s", user_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Avatar upload failed. Please try again.",
        ) from exc

    profile.avatar_url = public_url
    profile.updated_at = datetime.now(timezone.utc)

    try:
        await db.commit()
        await db.refresh(profile)
    except Exception as exc:
        await db.rollback()
        await _cleanup_avatar(storage_path)
        logger.exception("Could not persist avatar URL for user %s", user_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Avatar could not be saved. Please try again.",
        ) from exc

    # Only remove the old image after the database points at the new one.
    if old_storage_path and old_storage_path != storage_path:
        await _cleanup_avatar(old_storage_path)

    await broadcast_profile_updated(
        db=db,
        user_id=user_id,
        display_name=profile.display_name,
        username=profile.username,
        avatar_url=profile.avatar_url,
    )

    return {"profile": _profile_payload(profile, current_user.get("email"))}

@router.get("/search", response_model=list[UserSearchResult])
async def search_users(
    q: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = q.strip()
    if len(query) < 2:
        return []

    result = await db.execute(
        select(Profile)
        .where(
            Profile.id != uuid.UUID(current_user["id"]),
            or_(
                Profile.username.ilike(f"%{query}%"),
                Profile.display_name.ilike(f"%{query}%"),
            ),
        )
        .order_by(Profile.display_name)
        .limit(10)
    )

    profiles = result.scalars().all()
    return [
        UserSearchResult(
            id=str(profile.id),
            username=profile.username,
            display_name=profile.display_name,
            avatar_url=profile.avatar_url,
        )
        for profile in profiles
    ]


@router.post("/contacts")
async def add_contact(
    contact_data: ContactCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    contact = Contact(
        user_id=current_user["id"],
        contact_user_id=contact_data.contact_user_id,
    )

    db.add(contact)
    await db.commit()
    await db.refresh(contact)

    return {
        "contact": {
            "id": str(contact.id),
            "user_id": str(contact.user_id),
            "contact_user_id": str(contact.contact_user_id),
            "created_at": contact.created_at,
        }
    }


@router.get("/contacts")
async def get_contacts(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(
        select(Profile)
        .join(
            Contact,
            Contact.contact_user_id == Profile.id,
        )
        .where(
            Contact.user_id == current_user_id
        )
        .order_by(Profile.display_name)
    )

    profiles = result.scalars().all()

    return [
        {
            "id": str(profile.id),
            "username": profile.username,
            "displayName": profile.display_name,
            "avatarUrl": profile.avatar_url,
        }
        for profile in profiles
    ]
