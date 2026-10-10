import asyncio
import uuid

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

import logging

from app.services.connection_manager import manager

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.attachment import Attachment
from app.models.conversation_participants import ConversationParticipant
from app.models.message import Message
from app.services.media_service import create_storage_path, upload_file
from app.services.message_service import create_message
from app.services.storage_service import get_storage_client


router = APIRouter()

logger = logging.getLogger(__name__)

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

    # Verify conversation membership.
    result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    if result.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    # Fetch messages in chronological order.
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.asc())
    )

    messages = result.scalars().all()

    # Fetch attachments for these messages in one query.
    # This avoids issuing a separate database query per message.
    attachments_by_message = {}

    if messages:
        message_ids = [message.id for message in messages]

        result = await db.execute(
            select(Attachment).where(
                Attachment.message_id.in_(message_ids)
            )
        )

        attachments = result.scalars().all()

        for attachment in attachments:
            attachments_by_message.setdefault(
                attachment.message_id, []
            ).append(attachment)

    response = []

    for message in messages:
        message_attachments = attachments_by_message.get(
            message.id, []
        )

        attachment_data = [
            {
                "id": str(attachment.id),
                "fileName": attachment.file_name,
                "mimeType": attachment.mime_type,
                "size": attachment.file_size,
            }
            for attachment in message_attachments
        ]

        # Preserve ordinary text messages.
        # Identify media messages using their attachment MIME types.
        message_type = "text"

        if message_attachments:
            mime_type = message_attachments[0].mime_type.lower()

            if mime_type.startswith("image/"):
                message_type = "image"
            elif mime_type.startswith("video/"):
                message_type = "video"
            else:
                message_type = "file"

        response.append(
            {
                "id": str(message.id),
                "conversationId": str(message.conversation_id),
                "senderId": str(message.sender_id),
                "content": message.content,
                "createdAt": message.created_at,
                "status": message.status,
                "type": message_type,
                "attachments": attachment_data,
            }
        )

    return response

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


@router.post("/conversations/{conversation_id}/messages/attachments")
async def upload_attachment(
    conversation_id: uuid.UUID,
    file: UploadFile = File(...),
    caption: str = Form(default=""),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    # Collect conversation participants and verify authorization.
    result = await db.execute(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == conversation_id,
        )
    )
    participant_ids = result.scalars().all()

    if current_user_id not in participant_ids:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found",
        )

    max_file_size = 50 * 1024 * 1024
    file_bytes = await file.read(max_file_size + 1)

    if len(file_bytes) > max_file_size:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 50 MB upload limit.",
        )

    if not file_bytes:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty.",
        )

    # Remove directory components from the client-provided filename.
    original_name = (file.filename or "attachment").replace("\\", "/")
    original_name = original_name.rsplit("/", 1)[-1].strip()

    if not original_name or original_name in {".", ".."}:
        original_name = "attachment"

    content_type = file.content_type or "application/octet-stream"
    message_id = uuid.uuid4()

    storage_path = create_storage_path(
        conversation_id=conversation_id,
        message_id=message_id,
        file_name=original_name,
    )

    async def cleanup_storage_object() -> None:
        try:
            await asyncio.to_thread(
                get_storage_client().storage.from_("aperture-media").remove,
                [storage_path],
            )
        except Exception:
            logger.exception(
                "Unable to clean up media storage object after a failed operation."
            )

    # Upload first, before opening a database transaction for the records.
    try:
        await asyncio.to_thread(
            upload_file,
            file_bytes=file_bytes,
            storage_path=storage_path,
            content_type=content_type,
        )
    except Exception:
        # The storage request may have failed after the object was created.
        await cleanup_storage_object()
        raise

    message = Message(
        id=message_id,
        conversation_id=conversation_id,
        sender_id=current_user_id,
        content=caption.strip(),
        status="sent",
    )

    attachment = Attachment(
        message_id=message_id,
        file_name=original_name,
        mime_type=content_type,
        file_size=len(file_bytes),
        storage_path=storage_path,
    )

    # If persistence fails, roll back the database and compensate by
    # removing the uploaded object. Do not run cleanup after a successful
    # commit merely because a later operation fails.
    try:
        db.add(message)
        db.add(attachment)
        await db.commit()
    except Exception:
        await db.rollback()
        await cleanup_storage_object()
        raise

    mime_type = attachment.mime_type.lower()

    if mime_type.startswith("image/"):
        message_type = "image"
    elif mime_type.startswith("video/"):
        message_type = "video"
    else:
        message_type = "file"

    message_data = {
        "id": str(message.id),
        "conversationId": str(message.conversation_id),
        "senderId": str(message.sender_id),
        "content": message.content,
        "createdAt": message.created_at.isoformat(),
        "status": message.status,
        "type": message_type,
        "attachments": [
            {
                "id": str(attachment.id),
                "fileName": attachment.file_name,
                "mimeType": attachment.mime_type,
                "size": attachment.file_size,
            }
        ],
    }

    # Notify connected participants only after the database commit succeeds.
    for participant_id in participant_ids:
        try:
            await manager.send_to_user(
                str(participant_id),
                {
                    "type": "message.new",
                    "payload": message_data,
                },
            )
        except Exception:
            # The message is already saved; a delivery failure must not
            # cause the HTTP response to imply that persistence failed.
            logger.exception(
                "Attachment message %s was saved, but WebSocket delivery failed.",
                message.id,
            )

    return message_data

@router.get("/attachments/{attachment_id}/url")
async def get_attachment_url(
    attachment_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    # Find the attachment only if the requesting user belongs
    # to the conversation containing its message.
    result = await db.execute(
        select(Attachment)
        .join(
            Message,
            Attachment.message_id == Message.id,
        )
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id
            == Message.conversation_id,
        )
        .where(
            Attachment.id == attachment_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )

    attachment = result.scalar_one_or_none()

    if attachment is None:
        raise HTTPException(
            status_code=404,
            detail="Attachment not found",
        )

    try:
        # Generate a temporary URL without blocking the event loop.
        storage_response = await asyncio.to_thread(
            get_storage_client()
            .storage
            .from_("aperture-media")
            .create_signed_url,
            attachment.storage_path,
            300,
        )

    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="Unable to generate media access URL.",
        ) from exc

    if not isinstance(storage_response, dict):
        raise HTTPException(
            status_code=502,
            detail="Invalid response from media storage.",
        )

    signed_url = (
        storage_response.get("signedURL")
        or storage_response.get("signedUrl")
        or storage_response.get("signed_url")
    )

    if not isinstance(signed_url, str) or not signed_url:
        raise HTTPException(
            status_code=502,
            detail="Media storage did not return a valid URL.",
        )

    # Accommodate SDK versions that return a relative URL.
    if signed_url.startswith("/"):
        signed_url = (
            f"{settings.supabase_url.rstrip('/')}/storage/v1"
            f"{signed_url}"
        )

    elif not signed_url.startswith(("https://", "http://")):
        raise HTTPException(
            status_code=502,
            detail="Media storage returned an invalid URL.",
        )

    return {
        "attachmentId": str(attachment.id),
        "url": signed_url,
        "expiresIn": 300,
    }