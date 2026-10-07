import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.message_service import create_message

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.conversation_participants import ConversationParticipant
from app.models.message import Message


router = APIRouter()


@router.post("/conversations/{conversation_id}/messages")
@router.post("/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: uuid.UUID,
    data: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    message = await create_message(
        db=db,
        conversation_id=conversation_id,
        sender_id=current_user_id,
        content=data.get("content", ""),
    )

    return {
        "id": str(message.id),
        "conversationId": str(message.conversation_id),
        "senderId": str(message.sender_id),
        "content": message.content,
        "createdAt": message.created_at,
        "status": message.status,
    }

@router.get("/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    participant = result.scalar_one_or_none()

    if not participant:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )

    messages = result.scalars().all()

    return [
        {
            "id": str(message.id),
            "conversationId": str(message.conversation_id),
            "senderId": str(message.sender_id),
            "content": message.content,
            "createdAt": message.created_at,
            "status": message.status,
        }
        for message in messages
    ]

@router.post("/messages/{message_id}/read")
async def mark_message_read(
    message_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(
        select(Message).where(Message.id == message_id)
    )

    message = result.scalar_one_or_none()

    if not message:
        raise HTTPException(
            status_code=404,
            detail="Message not found",
        )

    # Make sure the current user belongs to this conversation
    result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == message.conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    participant = result.scalar_one_or_none()

    if not participant:
        raise HTTPException(
            status_code=404,
            detail="Message not found",
        )

    message.status = "read"

    await db.commit()

    return {
        "success": True,
        "messageId": str(message.id),
        "status": message.status,
    }