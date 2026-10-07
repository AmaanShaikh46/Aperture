from fastapi import APIRouter, Depends
from sqlalchemy import or_,select
from sqlalchemy.ext.asyncio import AsyncSession
import uuid
from app.schemas.user import ProfileUpdate, UserSearchResult

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.profiles import Profile

from app.models.contacts import Contact
from app.schemas.contact import ContactCreate


router = APIRouter(
    prefix="/users",
    tags=["Users"],
)


@router.get("/me")
async def get_my_profile(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Profile).where(
            Profile.id == current_user["id"]
        )
    )

    profile = result.scalar_one_or_none()

    if profile is None:
        return {
            "authenticated": True,
            "profile": None,
        }

    return {
        "authenticated": True,
        "profile": {
            "id": str(profile.id),
            "username": profile.username,
            "display_name": profile.display_name,
            "avatar_url": profile.avatar_url,
            "bio": profile.bio,
            "created_at": profile.created_at,
            "updated_at": profile.updated_at,
        },
    }


@router.patch("/me")
async def update_my_profile(
    profile_data: ProfileUpdate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Profile).where(
            Profile.id == current_user["id"]
        )
    )

    profile = result.scalar_one_or_none()

    if profile is None:
        return {
            "error": "Profile not found"
        }

    if profile_data.username is not None:
        profile.username = profile_data.username

    if profile_data.display_name is not None:
        profile.display_name = profile_data.display_name

    if profile_data.avatar_url is not None:
        profile.avatar_url = profile_data.avatar_url

    if profile_data.bio is not None:
        profile.bio = profile_data.bio

    await db.commit()
    await db.refresh(profile)

    return {
        "profile": {
            "id": str(profile.id),
            "username": profile.username,
            "display_name": profile.display_name,
            "avatar_url": profile.avatar_url,
            "bio": profile.bio,
            "created_at": profile.created_at,
            "updated_at": profile.updated_at,
        }
    }


@router.get("/search", response_model=list[UserSearchResult])
async def search_users(
    q: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = q.strip()

    if len(q) < 2:
        return []
    
    result = await db.execute(
        select(Profile)
        .where(
            Profile.id != current_user["id"],
            or_(
                Profile.username.ilike(f"%{q}%"),
                Profile.display_name.ilike(f"%{q}%"),
            )
        )
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
    current_user_id = uuid.UUID(current_user["id"])

    if contact_data.contact_user_id == current_user_id:
        return {
            "error": "You cannot add yourself as a contact"
        }

    # Check if the contact already exists
    result = await db.execute(
        select(Contact).where(
            Contact.user_id == current_user_id,
            Contact.contact_user_id == contact_data.contact_user_id,
        )
    )

    existing_contact = result.scalar_one_or_none()

    if existing_contact:
        return {
            "contact": {
                "id": str(existing_contact.id),
                "user_id": str(existing_contact.user_id),
                "contact_user_id": str(existing_contact.contact_user_id),
                "created_at": existing_contact.created_at,
            }
        }

    # Create new contact
    contact = Contact(
        user_id=current_user_id,
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
        .distinct()
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