import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation_participants import ConversationParticipant
from app.models.message import Message


async def create_message(
    db: AsyncSession,
    conversation_id: uuid.UUID,
    sender_id: uuid.UUID,
    content: str,
):
    # Make sure sender belongs to the conversation
    result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == sender_id,
        )
    )

    participant = result.scalar_one_or_none()

    if not participant:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    content = content.strip()

    if not content:
        raise HTTPException(
            status_code=400,
            detail="Message content cannot be empty",
        )

    message = Message(
        conversation_id=conversation_id,
        sender_id=sender_id,
        content=content,
        status="sent",
    )

    db.add(message)
    await db.commit()
    await db.refresh(message)

    return message