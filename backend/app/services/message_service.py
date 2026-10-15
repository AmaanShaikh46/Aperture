import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation_participants import ConversationParticipant
from app.models.message import Message
from app.models.message_receipt import MessageReceipt

from datetime import datetime, timezone
from app.models.conversations import Conversation

async def create_message(
    db: AsyncSession,
    conversation_id: uuid.UUID,
    sender_id: uuid.UUID,
    content: str,
):
    if not isinstance(content, str):
        raise HTTPException(
            status_code=400,
            detail="Message content must be text",
        )

    content = content.strip()

    if not content:
        raise HTTPException(
            status_code=400,
            detail="Message content cannot be empty",
        )

    if len(content) > 10_000:
        raise HTTPException(
            status_code=413,
            detail="Messages cannot exceed 10,000 characters.",
        )

    # Reject embedded null bytes and other non-text control characters.
    if "\x00" in content:
        raise HTTPException(
            status_code=400,
            detail="Message content contains unsupported characters",
        )

    # Verify the sender belongs to the conversation.
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

    # Verify the conversation exists.
    result = await db.execute(
        select(Conversation).where(
            Conversation.id == conversation_id
        )
    )

    conversation = result.scalar_one_or_none()

    if not conversation:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    try:
        message = Message(
            conversation_id=conversation_id,
            sender_id=sender_id,
            content=content,
            status="sent",
        )

        db.add(message)
        # Flush so the database-generated message ID is available before receipts
        # are added. Message and recipient receipt rows commit atomically.
        await db.flush()

        recipient_result = await db.execute(
            select(ConversationParticipant.user_id).where(
                ConversationParticipant.conversation_id == conversation_id,
                ConversationParticipant.user_id != sender_id,
            )
        )
        for recipient_id in recipient_result.scalars().all():
            db.add(
                MessageReceipt(
                    message_id=message.id,
                    user_id=recipient_id,
                    read_at=None,
                )
            )

        # Update conversation ordering for the conversation list.
        conversation.updated_at = datetime.now(timezone.utc)

        await db.commit()
        await db.refresh(message)

        return message

    except Exception:
        await db.rollback()
        raise