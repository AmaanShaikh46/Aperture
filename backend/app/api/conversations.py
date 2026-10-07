import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

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
    try:
        current_user_id = uuid.UUID(current_user["id"])
        target_user_id = uuid.UUID(data["userId"])
    except (ValueError, KeyError):
        raise HTTPException(
            status_code=400,
            detail="Invalid user ID",
        )

    if current_user_id == target_user_id:
        raise HTTPException(
            status_code=400,
            detail="Cannot create a conversation with yourself",
        )

    # Check that the target user exists
    result = await db.execute(
        select(Profile).where(Profile.id == target_user_id)
    )
    target_user = result.scalar_one_or_none()

    if not target_user:
        raise HTTPException(
            status_code=404,
            detail="User not found",
        )

    # Check existing direct conversations
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

    # Create a new conversation
    conversation = Conversation(
        type="direct",
    )

    db.add(conversation)
    await db.flush()

    db.add_all([
        ConversationParticipant(
            conversation_id=conversation.id,
            user_id=current_user_id,
        ),
        ConversationParticipant(
            conversation_id=conversation.id,
            user_id=target_user_id,
        ),
    ])

    await db.commit()
    await db.refresh(conversation)

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

    # Get conversations the current user belongs to
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

        # Get the other participant
        result = await db.execute(
            select(Profile)
            .join(
                ConversationParticipant,
                ConversationParticipant.user_id == Profile.id,
            )
            .where(
                ConversationParticipant.conversation_id == conversation.id,
                ConversationParticipant.user_id != current_user_id,
            )
        )

        participant = result.scalar_one_or_none()

        # Get latest message
        result = await db.execute(
            select(Message)
            .where(
                Message.conversation_id == conversation.id
            )
            .order_by(Message.created_at.desc())
            .limit(1)
        )

        last_message = result.scalar_one_or_none()

        response.append({
            "id": str(conversation.id),
            "type": conversation.type,

            "participantId": (
                str(participant.id)
                if participant
                else None
            ),

            "participantName": (
                participant.display_name
                if participant
                else "Unknown"
            ),

            "participantAvatar": (
                participant.avatar_url
                if participant
                else None
            ),

            "lastMessage": (
                {
                    "id": str(last_message.id),
                    "conversationId": str(last_message.conversation_id),
                    "senderId": str(last_message.sender_id),
                    "content": last_message.content,
                    "createdAt": last_message.created_at,
                    "status": last_message.status,
                }
                if last_message
                else None
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

    return {
        "id": str(conversation.id),
        "type": conversation.type,
        "createdAt": conversation.created_at,
        "updatedAt": conversation.updated_at,
        "lastMessage": None,
        "unreadCount": 0,
    }