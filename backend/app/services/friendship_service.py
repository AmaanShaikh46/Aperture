"""Shared authorization helpers for friend-gated direct communication."""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.friend_request import FriendRequest
from app.models.friendship import Friendship


def canonical_pair(user_a: uuid.UUID, user_b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    if user_a == user_b:
        raise ValueError("A user cannot have a relationship with themselves.")
    return (user_a, user_b) if user_a.int < user_b.int else (user_b, user_a)


async def are_friends(
    db: AsyncSession,
    user_a: uuid.UUID,
    user_b: uuid.UUID,
) -> bool:
    if user_a == user_b:
        return False
    low_id, high_id = canonical_pair(user_a, user_b)
    result = await db.execute(
        select(Friendship.id).where(
            Friendship.user_low_id == low_id,
            Friendship.user_high_id == high_id,
        )
    )
    return result.scalar_one_or_none() is not None


async def get_relationship_state(
    db: AsyncSession,
    user_a: uuid.UUID,
    user_b: uuid.UUID,
) -> dict[str, str | None]:
    """Return the relationship from user_a's point of view."""
    if user_a == user_b:
        return {"relationshipStatus": "self", "friendRequestId": None}

    low_id, high_id = canonical_pair(user_a, user_b)
    result = await db.execute(
        select(Friendship.id).where(
            Friendship.user_low_id == low_id,
            Friendship.user_high_id == high_id,
        )
    )
    if result.scalar_one_or_none() is not None:
        return {"relationshipStatus": "friends", "friendRequestId": None}

    result = await db.execute(
        select(FriendRequest).where(
            FriendRequest.user_low_id == low_id,
            FriendRequest.user_high_id == high_id,
        )
    )
    request = result.scalar_one_or_none()
    if request is not None and request.status == "pending":
        return {
            "relationshipStatus": "request_sent" if request.sender_id == user_a else "request_received",
            "friendRequestId": str(request.id),
        }
    return {"relationshipStatus": "none", "friendRequestId": None}


async def require_friends(
    db: AsyncSession,
    user_a: uuid.UUID,
    user_b: uuid.UUID,
) -> None:
    if user_a == user_b:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot message or call yourself.",
        )
    low_id, high_id = canonical_pair(user_a, user_b)
    # Lock the relationship row until the caller's transaction commits. This
    # serializes a message/call action against a concurrent friendship removal.
    result = await db.execute(
        select(Friendship.id)
        .where(
            Friendship.user_low_id == low_id,
            Friendship.user_high_id == high_id,
        )
        .with_for_update()
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only message or call friends. Send a friend request and wait for it to be accepted.",
        )


async def require_direct_conversation_friendship(
    db: AsyncSession,
    conversation_id: uuid.UUID,
    sender_id: uuid.UUID,
) -> None:
    """Require accepted friendship for messages in a direct conversation."""
    from app.models.conversation_participants import ConversationParticipant
    from app.models.conversations import Conversation

    result = await db.execute(
        select(Conversation).where(Conversation.id == conversation_id)
    )
    conversation = result.scalar_one_or_none()
    if conversation is None or conversation.type != "direct":
        return

    result = await db.execute(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id != sender_id,
        )
    )
    other_ids = list(result.scalars().all())
    if len(other_ids) != 1:
        raise HTTPException(status_code=409, detail="This direct conversation has an invalid participant list.")
    await require_friends(db, sender_id, other_ids[0])
