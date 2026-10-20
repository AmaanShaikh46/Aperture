import uuid

import logging

from app.services.connection_manager import manager

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import aliased
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.attachment import Attachment
from app.models.friend_request import FriendRequest
from app.models.friendship import Friendship

from datetime import datetime, timezone

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.conversations import Conversation
from app.models.conversation_participants import ConversationParticipant
from app.models.profiles import Profile

from app.models.message import Message
from app.services.friendship_service import canonical_pair, get_relationship_state, require_friends

router = APIRouter()

logger = logging.getLogger(__name__)

@router.post("/conversations")
async def create_conversation(
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    conversation_type = data.get("type", "direct")

    if conversation_type == "group":
        name = data.get("name")
        participant_ids_raw = data.get("participantIds")

        if not isinstance(name, str) or not name.strip():
            raise HTTPException(
                status_code=400,
                detail="Group name is required",
            )

        name = name.strip()

        if len(name) > 100:
            raise HTTPException(
                status_code=400,
                detail="Group name cannot exceed 100 characters",
            )

        if not isinstance(participant_ids_raw, list):
            raise HTTPException(
                status_code=400,
                detail="participantIds must be a list",
            )

        if len(participant_ids_raw) < 1:
            raise HTTPException(
                status_code=400,
                detail="A group requires at least two other participants",
            )

        if len(participant_ids_raw) > 100:
            raise HTTPException(
                status_code=400,
                detail="A group cannot have more than 100 invited participants",
            )

        try:
            participant_ids = [uuid.UUID(value) for value in participant_ids_raw]
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(
                status_code=400,
                detail="One or more participant IDs are invalid",
            )

        if len(set(participant_ids)) != len(participant_ids):
            raise HTTPException(
                status_code=400,
                detail="Duplicate participants are not allowed",
            )

        if current_user_id in participant_ids:
            raise HTTPException(
                status_code=400,
                detail="Do not include yourself in participantIds",
            )

        result = await db.execute(
            select(Profile.id).where(Profile.id.in_(participant_ids))
        )
        existing_ids = set(result.scalars().all())

        if existing_ids != set(participant_ids):
            raise HTTPException(
                status_code=400,
                detail="One or more participants do not exist",
            )

        conversation = Conversation(
            type="group",
            name=name,
        )

        try:
            db.add(conversation)
            await db.flush()

            db.add(
                ConversationParticipant(
                    conversation_id=conversation.id,
                    user_id=current_user_id,
                    role="admin",
                )
            )

            db.add_all([
                ConversationParticipant(
                    conversation_id=conversation.id,
                    user_id=participant_id,
                    role="member",
                )
                for participant_id in participant_ids
            ])

            await db.commit()
            await db.refresh(conversation)

        except Exception:
            await db.rollback()
            raise

        return {
            "id": str(conversation.id),
            "type": "group",
            "name": conversation.name,
            "participantId": None,
            "participantName": conversation.name,
            "participantAvatar": None,
            "relationshipStatus": "group",
            "friendRequestId": None,
            "participants": [],
            "lastMessage": None,
            "unreadCount": 0,
            "createdAt": conversation.created_at,
            "updatedAt": conversation.updated_at,
        }

    if conversation_type != "direct":
        raise HTTPException(
            status_code=400,
            detail="Unsupported conversation type",
        )

    try:
        target_user_id = uuid.UUID(data["userId"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(
            status_code=400,
            detail="Invalid user ID",
        )

    if current_user_id == target_user_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot create a conversation with yourself",
        )

    result = await db.execute(
        select(Profile).where(Profile.id == target_user_id)
    )
    target_user = result.scalar_one_or_none()

    if not target_user:
        raise HTTPException(
            status_code=404,
            detail="User not found",
        )

    # Keep scalar profile values available even if a concurrent insert forces a
    # transaction rollback, which expires ORM instances in SQLAlchemy.
    target_user_id_text = str(target_user.id)
    target_display_name = target_user.display_name or target_user.username or "Unknown"
    target_avatar_url = target_user.avatar_url

    # Direct conversations can only be created/retrieved after the friendship
    # has been accepted. The database's canonical-pair unique constraint is the
    # final protection against two concurrent requests creating duplicate DMs.
    await require_friends(db, current_user_id, target_user_id)
    low_id, high_id = canonical_pair(current_user_id, target_user_id)

    result = await db.execute(
        select(Conversation).where(
            Conversation.type == "direct",
            Conversation.direct_user_low_id == low_id,
            Conversation.direct_user_high_id == high_id,
        )
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        return {
            "id": str(existing.id),
            "type": existing.type,
            "participantId": target_user_id_text,
            "participantName": target_display_name,
            "participantAvatar": target_avatar_url,
            "relationshipStatus": "friends",
            "friendRequestId": None,
            "participants": [],
            "lastMessage": None,
            "unreadCount": 0,
            "createdAt": existing.created_at,
            "updatedAt": existing.updated_at,
        }

    conversation = Conversation(
        type="direct",
        direct_user_low_id=low_id,
        direct_user_high_id=high_id,
    )

    try:
        db.add(conversation)
        await db.flush()
        db.add_all([
            ConversationParticipant(
                conversation_id=conversation.id,
                user_id=current_user_id,
                role="member",
            ),
            ConversationParticipant(
                conversation_id=conversation.id,
                user_id=target_user_id,
                role="member",
            ),
        ])
        await db.commit()
        await db.refresh(conversation)
    except IntegrityError:
        await db.rollback()
        # Another request may have created the same pair after our initial
        # lookup. Retrieve the uniquely constrained row instead of duplicating it.
        result = await db.execute(
            select(Conversation).where(
                Conversation.type == "direct",
                Conversation.direct_user_low_id == low_id,
                Conversation.direct_user_high_id == high_id,
            )
        )
        conversation = result.scalar_one_or_none()
        if conversation is None:
            raise
    except Exception:
        await db.rollback()
        raise

    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "participantId": target_user_id_text,
        "participantName": target_display_name,
        "participantAvatar": target_avatar_url,
        "relationshipStatus": "friends",
        "friendRequestId": None,
        "participants": [],
        "lastMessage": None,
        "unreadCount": 0,
        "createdAt": conversation.created_at,
        "updatedAt": conversation.updated_at,
    }

@router.get("/conversations")
async def get_conversations(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the user's conversation list with a bounded number of DB queries.

    The old implementation performed several queries inside the per-conversation
    loop. With N conversations that caused roughly 4N-6N round trips to the
    hosted database. This implementation batches participants, latest messages,
    latest-message attachments, and relationship state so response latency does
    not grow linearly with the number of chats.
    """
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(
        select(Conversation)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(ConversationParticipant.user_id == current_user_id)
        .order_by(Conversation.updated_at.desc())
    )
    conversations = result.scalars().all()
    if not conversations:
        return []

    conversation_ids = [conversation.id for conversation in conversations]

    # Load participants for every conversation in a single query.
    participant_result = await db.execute(
        select(
            ConversationParticipant.conversation_id,
            Profile,
            ConversationParticipant.role,
        )
        .join(Profile, ConversationParticipant.user_id == Profile.id)
        .where(ConversationParticipant.conversation_id.in_(conversation_ids))
    )
    participant_rows_by_conversation: dict[uuid.UUID, list[tuple[Profile, str]]] = {}
    for conversation_id, profile, role in participant_result.all():
        participant_rows_by_conversation.setdefault(conversation_id, []).append((profile, role))

    # A correlated LIMIT 1 query uses the (conversation_id, created_at, id)
    # index to seek to the newest message for each conversation. This avoids
    # scanning/ranking every historical message just to render chat-list previews.
    latest_message_candidate = aliased(Message)
    latest_message_id = (
        select(latest_message_candidate.id)
        .where(latest_message_candidate.conversation_id == Conversation.id)
        .order_by(
            latest_message_candidate.created_at.desc(),
            latest_message_candidate.id.desc(),
        )
        .limit(1)
        .correlate(Conversation)
        .scalar_subquery()
    )
    latest_message_result = await db.execute(
        select(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Conversation.id.in_(conversation_ids),
            Message.id == latest_message_id,
        )
    )
    latest_messages = latest_message_result.scalars().all()
    latest_message_by_conversation = {
        message.conversation_id: message for message in latest_messages
    }

    # Load attachments only for the messages actually shown in the chat list.
    latest_message_ids = [message.id for message in latest_messages]
    attachments_by_message: dict[uuid.UUID, list[Attachment]] = {}
    if latest_message_ids:
        attachment_result = await db.execute(
            select(Attachment).where(Attachment.message_id.in_(latest_message_ids))
        )
        for attachment in attachment_result.scalars().all():
            attachments_by_message.setdefault(attachment.message_id, []).append(attachment)

    # Resolve relationship state for all direct-chat peers in two batched queries
    # rather than two queries per direct conversation.
    peer_ids = {
        profile.id
        for conversation in conversations
        if conversation.type == "direct"
        for profile, _role in participant_rows_by_conversation.get(conversation.id, [])
        if profile.id != current_user_id
    }
    friend_ids: set[uuid.UUID] = set()
    pending_requests_by_peer: dict[uuid.UUID, FriendRequest] = {}
    if peer_ids:
        friendship_result = await db.execute(
            select(Friendship.user_low_id, Friendship.user_high_id).where(
                or_(
                    and_(
                        Friendship.user_low_id == current_user_id,
                        Friendship.user_high_id.in_(peer_ids),
                    ),
                    and_(
                        Friendship.user_high_id == current_user_id,
                        Friendship.user_low_id.in_(peer_ids),
                    ),
                )
            )
        )
        for low_id, high_id in friendship_result.all():
            friend_ids.add(high_id if low_id == current_user_id else low_id)

        request_result = await db.execute(
            select(FriendRequest).where(
                FriendRequest.status == "pending",
                or_(
                    and_(
                        FriendRequest.sender_id == current_user_id,
                        FriendRequest.recipient_id.in_(peer_ids),
                    ),
                    and_(
                        FriendRequest.recipient_id == current_user_id,
                        FriendRequest.sender_id.in_(peer_ids),
                    ),
                ),
            )
        )
        for request in request_result.scalars().all():
            peer_id = (
                request.recipient_id
                if request.sender_id == current_user_id
                else request.sender_id
            )
            pending_requests_by_peer[peer_id] = request

    response = []
    for conversation in conversations:
        participant_rows = participant_rows_by_conversation.get(conversation.id, [])
        participants = [
            {
                "id": str(profile.id),
                "displayName": profile.display_name or profile.username or "Unknown",
                "avatarUrl": profile.avatar_url,
                "role": role,
            }
            for profile, role in participant_rows
        ]

        other_participant = next(
            (profile for profile, _role in participant_rows if profile.id != current_user_id),
            None,
        )

        if conversation.type == "group":
            participant_name = conversation.name or "Unnamed Group"
            participant_id = None
            participant_avatar = None
            relationship = {"relationshipStatus": "group", "friendRequestId": None}
        else:
            participant_name = (
                (other_participant.display_name or other_participant.username or "Unknown")
                if other_participant
                else "Unknown"
            )
            participant_id = str(other_participant.id) if other_participant else None
            participant_avatar = other_participant.avatar_url if other_participant else None

            if other_participant is None:
                relationship = {"relationshipStatus": "group", "friendRequestId": None}
            elif other_participant.id in friend_ids:
                relationship = {"relationshipStatus": "friends", "friendRequestId": None}
            elif other_participant.id in pending_requests_by_peer:
                request = pending_requests_by_peer[other_participant.id]
                relationship = {
                    "relationshipStatus": (
                        "request_sent" if request.sender_id == current_user_id else "request_received"
                    ),
                    "friendRequestId": str(request.id),
                }
            else:
                relationship = {"relationshipStatus": "none", "friendRequestId": None}

        last_message = latest_message_by_conversation.get(conversation.id)
        last_message_attachments = (
            attachments_by_message.get(last_message.id, []) if last_message else []
        )

        response.append(
            {
                "id": str(conversation.id),
                "type": conversation.type,
                "name": conversation.name,
                "participantId": participant_id,
                "participantName": participant_name,
                "participantAvatar": participant_avatar,
                "relationshipStatus": relationship["relationshipStatus"],
                "friendRequestId": relationship["friendRequestId"],
                "participants": participants,
                "lastMessage": (
                    {
                        "id": str(last_message.id),
                        "conversationId": str(last_message.conversation_id),
                        "senderId": str(last_message.sender_id),
                        "content": last_message.content,
                        "createdAt": last_message.created_at,
                        "status": last_message.status,
                        "attachments": [
                            {
                                "id": str(attachment.id),
                                "fileName": attachment.file_name,
                                "mimeType": attachment.mime_type,
                                "size": attachment.file_size,
                            }
                            for attachment in last_message_attachments
                        ],
                    }
                    if last_message
                    else None
                ),
                "unreadCount": 0,
                "createdAt": conversation.created_at,
                "updatedAt": conversation.updated_at,
            }
        )

    return response

@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    # Verify the conversation exists and the current user is a member.
    result = await db.execute(
        select(Conversation)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    conversation = result.scalar_one_or_none()

    if not conversation:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    # Fetch all participants and their roles.
    participant_result = await db.execute(
        select(Profile, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.user_id == Profile.id,
        )
        .where(
            ConversationParticipant.conversation_id == conversation.id
        )
    )

    participant_rows = participant_result.all()

    participants = [
        {
            "id": str(profile.id),
            "displayName": profile.display_name or profile.username or "Unknown",
            "avatarUrl": profile.avatar_url,
            "role": role,
        }
        for profile, role in participant_rows
    ]

    # Identify the other member in a direct conversation.
    other_participant = next(
        (
            profile
            for profile, _role in participant_rows
            if profile.id != current_user_id
        ),
        None,
    )

    if conversation.type == "group":
        participant_name = conversation.name or "Unnamed Group"
        participant_id = None
        participant_avatar = None
    else:
        participant_name = (
            (
                other_participant.display_name
                or other_participant.username
                or "Unknown"
            )
            if other_participant
            else "Unknown"
        )

        participant_id = (
            str(other_participant.id)
            if other_participant
            else None
        )

        participant_avatar = (
            other_participant.avatar_url
            if other_participant
            else None
        )

    relationship = (
        await get_relationship_state(db, current_user_id, other_participant.id)
        if conversation.type == "direct" and other_participant
        else {"relationshipStatus": "group", "friendRequestId": None}
    )

    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "name": conversation.name,
        "participantId": participant_id,
        "participantName": participant_name,
        "participantAvatar": participant_avatar,
        "relationshipStatus": relationship["relationshipStatus"],
        "friendRequestId": relationship["friendRequestId"],
        "participants": participants,
        "createdAt": conversation.created_at,
        "updatedAt": conversation.updated_at,
        "lastMessage": None,
        "unreadCount": 0,
    }

@router.patch("/conversations/{conversation_id}/name")
async def rename_group_conversation(
    conversation_id: uuid.UUID,
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rename a group conversation. Only group admins may do this."""
    current_user_id = uuid.UUID(current_user["id"])

    # Validate the new group name.
    name = data.get("name")

    if not isinstance(name, str) or not name.strip():
        raise HTTPException(
            status_code=400,
            detail="Group name is required",
        )

    name = name.strip()

    if len(name) > 100:
        raise HTTPException(
            status_code=400,
            detail="Group name cannot exceed 100 characters",
        )

    # Find the conversation and verify the current user's membership.
    result = await db.execute(
        select(Conversation, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    row = result.one_or_none()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    conversation, role = row

    # This endpoint is only for group conversations.
    if conversation.type != "group":
        raise HTTPException(
            status_code=400,
            detail="This operation is only available for group conversations",
        )

    # Only admins may rename the group.
    if role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only group admins can rename the group",
        )

    # Save the change.
    conversation.name = name
    conversation.updated_at = datetime.now(timezone.utc)

    try:
        await db.commit()
        await db.refresh(conversation)
    except Exception:
        await db.rollback()
        raise
        # Notify every connected group member about the renamed group.
    try:
        result = await db.execute(
            select(ConversationParticipant.user_id).where(
                ConversationParticipant.conversation_id == conversation.id
            )
        )

        event = {
            "type": "group.updated",
            "payload": {
                "conversationId": str(conversation.id),
                "name": conversation.name,
                "updatedAt": (
                    conversation.updated_at.isoformat()
                    if conversation.updated_at
                    else None
                ),
            },
        }

        for recipient_id in result.scalars().all():
            await manager.send_to_user(str(recipient_id), event)

    except Exception:
        logger.exception(
            "Failed to broadcast group rename for conversation %s",
            conversation.id,
        )
    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "name": conversation.name,
        "updatedAt": conversation.updated_at,
    }

@router.post("/conversations/{conversation_id}/participants")
async def add_group_participants(
    conversation_id: uuid.UUID,
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add members to a group. Only group admins may do this."""
    current_user_id = uuid.UUID(current_user["id"])

    # Validate the supplied participant IDs.
    participant_ids_raw = data.get("participantIds")

    if not isinstance(participant_ids_raw, list) or not participant_ids_raw:
        raise HTTPException(
            status_code=400,
            detail="participantIds must be a non-empty list",
        )

    if len(participant_ids_raw) > 100:
        raise HTTPException(
            status_code=400,
            detail="You cannot add more than 100 participants at once",
        )

    try:
        participant_ids = [
            uuid.UUID(value) for value in participant_ids_raw
        ]
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(
            status_code=400,
            detail="One or more participant IDs are invalid",
        )

    if len(set(participant_ids)) != len(participant_ids):
        raise HTTPException(
            status_code=400,
            detail="Duplicate participants are not allowed",
        )

    if current_user_id in participant_ids:
        raise HTTPException(
            status_code=400,
            detail="You are already a group member",
        )

    # Verify the conversation exists and the user belongs to it.
    result = await db.execute(
        select(Conversation, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    row = result.one_or_none()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    conversation, role = row

    if conversation.type != "group":
        raise HTTPException(
            status_code=400,
            detail="Members can only be added to group conversations",
        )

    if role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only group admins can add members",
        )

    # Verify that every selected user has a profile.
    profile_result = await db.execute(
        select(Profile).where(Profile.id.in_(participant_ids))
    )
    profiles = profile_result.scalars().all()
    profiles_by_id = {profile.id: profile for profile in profiles}

    if set(profiles_by_id) != set(participant_ids):
        raise HTTPException(
            status_code=400,
            detail="One or more participants do not exist",
        )

    # Find current members so nobody is inserted twice.
    existing_result = await db.execute(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == conversation_id
        )
    )
    existing_ids = set(existing_result.scalars().all())

    new_ids = [
        participant_id
        for participant_id in participant_ids
        if participant_id not in existing_ids
    ]

    if len(existing_ids) + len(new_ids) > 101:
        raise HTTPException(
            status_code=400,
            detail="A group cannot have more than 101 members",
        )

    # Persist all new memberships in one transaction.
    if new_ids:
        db.add_all(
            [
                ConversationParticipant(
                    conversation_id=conversation_id,
                    user_id=participant_id,
                    role="member",
                )
                for participant_id in new_ids
            ]
        )

        conversation.updated_at = datetime.now(timezone.utc)

        try:
            await db.commit()
            await db.refresh(conversation)
        except Exception:
            await db.rollback()
            raise

    # Load the complete participant list after the database update.
    participant_result = await db.execute(
        select(Profile, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.user_id == Profile.id,
        )
        .where(
            ConversationParticipant.conversation_id == conversation_id
        )
    )
    participant_rows = participant_result.all()

    participants = [
        {
            "id": str(profile.id),
            "displayName": (
                profile.display_name or profile.username or "Unknown"
            ),
            "avatarUrl": profile.avatar_url,
            "role": participant_role,
        }
        for profile, participant_role in participant_rows
    ]

    payload = {
        "conversationId": str(conversation.id),
        "name": conversation.name,
        "updatedAt": (
            conversation.updated_at.isoformat()
            if conversation.updated_at
            else None
        ),
        "addedMemberIds": [str(user_id) for user_id in new_ids],
        "participants": participants,
    }

    # Notify all current members, including the newly added users.
    # A notification failure must not undo the database transaction.
    if new_ids:
        event = {
            "type": "group.members_added",
            "payload": payload,
        }

        for profile, _participant_role in participant_rows:
            try:
                await manager.send_to_user(str(profile.id), event)
            except Exception:
                logger.exception(
                    "Failed to broadcast group membership update "
                    "for conversation %s to user %s",
                    conversation.id,
                    profile.id,
                )

    return payload

@router.delete("/conversations/{conversation_id}/participants/{participant_id}")
async def remove_group_participant(
    conversation_id: uuid.UUID,
    participant_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a regular member from a group. Only admins may do this."""
    current_user_id = uuid.UUID(current_user["id"])

    if participant_id == current_user_id:
        raise HTTPException(
            status_code=400,
            detail="Admins cannot remove themselves. Admin transfer is not available yet.",
        )

    # Verify the requester is a member and retrieve their role.
    result = await db.execute(
        select(Conversation, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    row = result.one_or_none()

    if row is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation, requester_role = row

    if conversation.type != "group":
        raise HTTPException(
            status_code=400,
            detail="Members can only be removed from group conversations",
        )

    if requester_role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only group admins can remove members",
        )

    # Find the target membership. Do not allow removal of an administrator.
    target_result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == participant_id,
        )
    )
    target_membership = target_result.scalar_one_or_none()

    if target_membership is None:
        raise HTTPException(
            status_code=404,
            detail="That user is not a member of this group",
        )

    if target_membership.role == "admin":
        raise HTTPException(
            status_code=400,
            detail="Administrators cannot be removed. Transfer admin role first.",
        )

    # Commit the membership removal before sending notifications.
    await db.delete(target_membership)
    conversation.updated_at = datetime.now(timezone.utc)

    try:
        await db.commit()
        await db.refresh(conversation)
    except Exception:
        await db.rollback()
        raise

    # Build the authoritative remaining-member list.
    participant_result = await db.execute(
        select(Profile, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.user_id == Profile.id,
        )
        .where(ConversationParticipant.conversation_id == conversation_id)
    )
    participant_rows = participant_result.all()

    participants = [
        {
            "id": str(profile.id),
            "displayName": profile.display_name or profile.username or "Unknown",
            "avatarUrl": profile.avatar_url,
            "role": member_role,
        }
        for profile, member_role in participant_rows
    ]

    payload = {
        "conversationId": str(conversation.id),
        "name": conversation.name,
        "updatedAt": conversation.updated_at.isoformat() if conversation.updated_at else None,
        "removedMemberId": str(participant_id),
        "participants": participants,
    }
    event = {"type": "group.members_removed", "payload": payload}

    # Notify remaining members and the removed user. Notification failure
    # must not roll back the already-committed membership change.
    recipient_ids = {str(profile.id) for profile, _role in participant_rows}
    recipient_ids.add(str(participant_id))

    for recipient_id in recipient_ids:
        try:
            await manager.send_to_user(recipient_id, event)
        except Exception:
            logger.exception(
                "Failed to broadcast member removal for conversation %s to user %s",
                conversation.id,
                recipient_id,
            )

    return payload



@router.post("/conversations/{conversation_id}/transfer-admin")
async def transfer_group_admin(
    conversation_id: uuid.UUID,
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Transfer the sole group-admin role from the caller to a regular member."""
    current_user_id = uuid.UUID(current_user["id"])

    try:
        target_user_id = uuid.UUID(data.get("participantId"))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(status_code=400, detail="Invalid participant ID")

    if target_user_id == current_user_id:
        raise HTTPException(
            status_code=400,
            detail="Choose another member to receive group administration",
        )

    result = await db.execute(
        select(Conversation, ConversationParticipant)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation, current_membership = row
    if conversation.type != "group":
        raise HTTPException(
            status_code=400,
            detail="Administration can only be transferred in a group",
        )
    if current_membership.role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only the current group admin can transfer administration",
        )

    target_result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == target_user_id,
        )
    )
    target_membership = target_result.scalar_one_or_none()
    if target_membership is None:
        raise HTTPException(
            status_code=404,
            detail="The selected user is not a member of this group",
        )
    if target_membership.role == "admin":
        raise HTTPException(
            status_code=400,
            detail="The selected member is already an administrator",
        )

    # Change both roles in the same transaction so the group always retains an admin.
    current_membership.role = "member"
    target_membership.role = "admin"
    conversation.updated_at = datetime.now(timezone.utc)

    try:
        await db.commit()
        await db.refresh(conversation)
    except Exception:
        await db.rollback()
        raise

    participant_result = await db.execute(
        select(Profile, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.user_id == Profile.id,
        )
        .where(ConversationParticipant.conversation_id == conversation_id)
    )
    participant_rows = participant_result.all()
    participants = [
        {
            "id": str(profile.id),
            "displayName": profile.display_name or profile.username or "Unknown",
            "avatarUrl": profile.avatar_url,
            "role": member_role,
        }
        for profile, member_role in participant_rows
    ]

    payload = {
        "conversationId": str(conversation.id),
        "name": conversation.name,
        "updatedAt": conversation.updated_at.isoformat() if conversation.updated_at else None,
        "adminUserId": str(target_user_id),
        "participants": participants,
    }
    event = {"type": "group.role_updated", "payload": payload}
    for profile, _role in participant_rows:
        try:
            await manager.send_to_user(str(profile.id), event)
        except Exception:
            logger.exception(
                "Failed to broadcast admin transfer for conversation %s to user %s",
                conversation.id,
                profile.id,
            )

    return payload


@router.post("/conversations/{conversation_id}/leave")
async def leave_group_conversation(
    conversation_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Leave a group as a regular member. Admins must transfer admin first."""
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(
        select(Conversation, ConversationParticipant)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation, membership = row
    if conversation.type != "group":
        raise HTTPException(
            status_code=400,
            detail="You can only leave group conversations using this action",
        )
    if membership.role == "admin":
        raise HTTPException(
            status_code=400,
            detail="Transfer admin rights to another member before leaving the group",
        )

    await db.delete(membership)
    conversation.updated_at = datetime.now(timezone.utc)
    try:
        await db.commit()
        await db.refresh(conversation)
    except Exception:
        await db.rollback()
        raise

    participant_result = await db.execute(
        select(Profile, ConversationParticipant.role)
        .join(
            ConversationParticipant,
            ConversationParticipant.user_id == Profile.id,
        )
        .where(ConversationParticipant.conversation_id == conversation_id)
    )
    participant_rows = participant_result.all()
    participants = [
        {
            "id": str(profile.id),
            "displayName": profile.display_name or profile.username or "Unknown",
            "avatarUrl": profile.avatar_url,
            "role": member_role,
        }
        for profile, member_role in participant_rows
    ]

    payload = {
        "conversationId": str(conversation.id),
        "name": conversation.name,
        "updatedAt": conversation.updated_at.isoformat() if conversation.updated_at else None,
        "removedMemberId": str(current_user_id),
        "leftBySelf": True,
        "participants": participants,
    }
    event = {"type": "group.members_removed", "payload": payload}
    recipient_ids = {str(profile.id) for profile, _role in participant_rows}
    recipient_ids.add(str(current_user_id))
    for recipient_id in recipient_ids:
        try:
            await manager.send_to_user(recipient_id, event)
        except Exception:
            logger.exception(
                "Failed to broadcast group departure for conversation %s to user %s",
                conversation.id,
                recipient_id,
            )

    return payload
