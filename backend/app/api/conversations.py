import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.attachment import Attachment

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.conversations import Conversation
from app.models.conversation_participants import ConversationParticipant
from app.models.profiles import Profile

from app.models.message import Message

router = APIRouter()


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

        if len(participant_ids_raw) < 2:
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

    result = await db.execute(
        select(Conversation)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            Conversation.type == "direct",
            ConversationParticipant.user_id == current_user_id,
        )
    )

    conversations = result.scalars().all()

    for conversation in conversations:
        result = await db.execute(
            select(ConversationParticipant.user_id).where(
                ConversationParticipant.conversation_id == conversation.id
            )
        )

        participant_ids = set(result.scalars().all())

        if participant_ids == {current_user_id, target_user_id}:
            return {
                "id": str(conversation.id),
                "type": conversation.type,
                "participantId": str(target_user.id),
                "participantName": target_user.display_name,
                "participantAvatar": target_user.avatar_url,
                "lastMessage": None,
                "unreadCount": 0,
                "createdAt": conversation.created_at,
                "updatedAt": conversation.updated_at,
            }

    conversation = Conversation(type="direct")

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

    except Exception:
        await db.rollback()
        raise

    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "participantId": str(target_user.id),
        "participantName": target_user.display_name,
        "participantAvatar": target_user.avatar_url,
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
    current_user_id = uuid.UUID(current_user["id"])

    # Get conversations the current user belongs to.
    result = await db.execute(
        select(Conversation)
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Conversation.id,
        )
        .where(
            ConversationParticipant.user_id == current_user_id
        )
        .order_by(Conversation.updated_at.desc())
    )

    conversations = result.scalars().all()
    response = []

    for conversation in conversations:
        # Fetch every participant and their role.
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

        # Find the other participant for direct conversations.
        other_participant = next(
            (
                profile
                for profile, _role in participant_rows
                if profile.id != current_user_id
            ),
            None,
        )

        # Group conversations use their group name.
        if conversation.type == "group":
            participant_name = conversation.name or "Unnamed Group"
            participant_id = None
            participant_avatar = None
        else:
            participant_name = (
                other_participant.display_name
                or other_participant.username
                or "Unknown"
            ) if other_participant else "Unknown"

            participant_id = (
                str(other_participant.id)
                if other_participant else None
            )

            participant_avatar = (
                other_participant.avatar_url
                if other_participant else None
            )

        # Get the latest message.
        message_result = await db.execute(
            select(Message)
            .where(
                Message.conversation_id == conversation.id
            )
            .order_by(Message.created_at.desc())
            .limit(1)
        )

        last_message = message_result.scalar_one_or_none()

        # Get attachments belonging to the latest message.
        last_message_attachments = []

        if last_message:
            attachment_result = await db.execute(
                select(Attachment)
                .where(
                    Attachment.message_id == last_message.id
                )
            )
            last_message_attachments = attachment_result.scalars().all()

        response.append({
            "id": str(conversation.id),
            "type": conversation.type,
            "name": conversation.name,

            "participantId": participant_id,
            "participantName": participant_name,
            "participantAvatar": participant_avatar,

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
                if last_message else None
            ),

            "unreadCount": 0,

            "createdAt": conversation.created_at,
            "updatedAt": conversation.updated_at,
        })

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

    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "name": conversation.name,
        "participantId": participant_id,
        "participantName": participant_name,
        "participantAvatar": participant_avatar,
        "participants": participants,
        "createdAt": conversation.created_at,
        "updatedAt": conversation.updated_at,
        "lastMessage": None,
        "unreadCount": 0,
    }