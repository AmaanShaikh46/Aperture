import asyncio
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

import logging

from app.services.connection_manager import manager

from app.core.security import get_current_user
from app.database.database import get_db
from app.models.attachment import Attachment
from app.models.conversation_participants import ConversationParticipant
from app.models.message import Message
from app.models.message_receipt import MessageReceipt
from app.models.conversations import Conversation
from app.services.media_service import (
    MAX_FILE_SIZE,
    create_storage_path,
    upload_file,
    validate_attachment_content,
)
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

    # Fetch recipients before persistence so a post-commit lookup failure cannot
    # turn a successfully saved message into a failed HTTP response.
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

    message = await create_message(
        db=db,
        conversation_id=conversation_id,
        sender_id=current_user_id,
        content=data.get("content", ""),
    )

    message_data = {
        "id": str(message.id),
        "conversationId": str(message.conversation_id),
        "senderId": str(message.sender_id),
        "content": message.content,
        "createdAt": message.created_at.isoformat(),
        "status": message.status,
        "receipts": [
            {"userId": str(participant_id), "status": "unread", "readAt": None}
            for participant_id in participant_ids
            if participant_id != current_user_id
        ],
    }

    # HTTP-created messages must reach connected participants just like
    # WebSocket-created messages. Delivery is best-effort: the DB commit above
    # is authoritative, so a socket failure must not make the HTTP request fail.
    for participant_id in participant_ids:
        try:
            await manager.send_to_user(
                str(participant_id),
                {"type": "message.new", "payload": message_data},
            )
        except Exception:
            logger.exception(
                "Message %s was saved, but WebSocket delivery failed.",
                message.id,
            )

    return message_data

@router.get("/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=100),
    before_created_at: datetime | None = None,
    before_id: uuid.UUID | None = None,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    # Verify conversation membership before returning any history.
    result = await db.execute(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # The compound cursor makes pagination deterministic when messages share a
    # timestamp. Both cursor fields must be supplied together.
    if (before_created_at is None) != (before_id is None):
        raise HTTPException(
            status_code=400,
            detail="Both before_created_at and before_id are required for pagination.",
        )

    query = select(Message).where(Message.conversation_id == conversation_id)
    if before_created_at is not None and before_id is not None:
        if before_created_at.tzinfo is None:
            before_created_at = before_created_at.replace(tzinfo=timezone.utc)
        query = query.where(
            or_(
                Message.created_at < before_created_at,
                and_(
                    Message.created_at == before_created_at,
                    Message.id < before_id,
                ),
            )
        )

    # Read newest-first with one extra row to determine if older history exists;
    # reverse the selected page before serializing so the client gets chronology.
    result = await db.execute(
        query
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit + 1)
    )
    newest_first = list(result.scalars().all())
    has_more = len(newest_first) > limit
    messages = list(reversed(newest_first[:limit]))

    # Fetch attachments and read receipts in bulk for this page only.
    attachments_by_message = {}
    receipts_by_message = {}

    if messages:
        message_ids = [message.id for message in messages]

        result = await db.execute(
            select(Attachment).where(Attachment.message_id.in_(message_ids))
        )
        for attachment in result.scalars().all():
            attachments_by_message.setdefault(attachment.message_id, []).append(attachment)

        result = await db.execute(
            select(MessageReceipt).where(MessageReceipt.message_id.in_(message_ids))
        )
        for receipt in result.scalars().all():
            receipts_by_message.setdefault(receipt.message_id, []).append(
                {
                    "userId": str(receipt.user_id),
                    "status": "read" if receipt.read_at is not None else "unread",
                    "readAt": receipt.read_at.isoformat() if receipt.read_at else None,
                }
            )

    response = []
    for message in messages:
        message_attachments = attachments_by_message.get(message.id, [])
        attachment_data = [
            {
                "id": str(attachment.id),
                "fileName": attachment.file_name,
                "mimeType": attachment.mime_type,
                "size": attachment.file_size,
            }
            for attachment in message_attachments
        ]

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
                "createdAt": message.created_at.isoformat(),
                "status": message.status,
                "type": message_type,
                "attachments": attachment_data,
                # Empty for legacy messages created before read receipts existed.
                "receipts": receipts_by_message.get(message.id, []),
            }
        )

    # Cursor points at the oldest item in this page; it is only needed when the
    # database indicates that an earlier page remains.
    next_cursor = None
    if has_more and messages:
        oldest_message = messages[0]
        next_cursor = {
            "createdAt": oldest_message.created_at.isoformat(),
            "id": str(oldest_message.id),
        }

    return {
        "items": response,
        "hasMore": has_more,
        "nextCursor": next_cursor,
    }

@router.post("/messages/{message_id}/read")
async def mark_message_read(
    message_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(select(Message).where(Message.id == message_id))
    message = result.scalar_one_or_none()

    if message is None:
        raise HTTPException(status_code=404, detail="Message not found")

    # Verify membership without revealing whether an inaccessible message exists.
    membership_result = await db.execute(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == message.conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    if membership_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Message not found")

    if message.sender_id == current_user_id:
        raise HTTPException(status_code=400, detail="You cannot mark your own message as read.")

    read_at = datetime.now(timezone.utc)

    # PostgreSQL upsert makes repeated read requests idempotent and preserves the
    # first read timestamp if multiple tabs report the same message.
    receipt_insert = pg_insert(MessageReceipt).values(
        message_id=message.id,
        user_id=current_user_id,
        read_at=read_at,
    )
    receipt_upsert = receipt_insert.on_conflict_do_update(
        index_elements=[MessageReceipt.message_id, MessageReceipt.user_id],
        set_={
            "read_at": func.coalesce(
                MessageReceipt.read_at,
                receipt_insert.excluded.read_at,
            )
        },
    )
    await db.execute(receipt_upsert)

    # Keep the legacy single-message status meaningful for direct chats only.
    # A single group's member reading must not make the whole group message read.
    conversation_result = await db.execute(
        select(Conversation.type).where(Conversation.id == message.conversation_id)
    )
    conversation_type = conversation_result.scalar_one_or_none()
    if conversation_type == "direct":
        message.status = "read"

    # Resolve response data and recipients before commit so a post-commit
    # database lookup failure cannot make a saved read receipt look unsuccessful.
    receipt_result = await db.execute(
        select(MessageReceipt).where(
            MessageReceipt.message_id == message.id,
            MessageReceipt.user_id == current_user_id,
        )
    )
    receipt = receipt_result.scalar_one()
    serialized_read_at = receipt.read_at.isoformat() if receipt.read_at else read_at.isoformat()

    participant_result = await db.execute(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == message.conversation_id,
        )
    )
    participant_ids = participant_result.scalars().all()

    await db.commit()

    # Notify all currently connected participants. Persistence is authoritative;
    # a delivery failure must not undo or fail the read receipt.
    event = {
        "type": "message.read",
        "payload": {
            "messageId": str(message.id),
            "conversationId": str(message.conversation_id),
            "userId": str(current_user_id),
            "status": "read",
            "readAt": serialized_read_at,
        },
    }
    for participant_id in participant_ids:
        try:
            await manager.send_to_user(str(participant_id), event)
        except Exception:
            logger.exception(
                "Read receipt for message %s was saved, but realtime delivery failed.",
                message.id,
            )

    return {
        "success": True,
        "messageId": str(message.id),
        "conversationId": str(message.conversation_id),
        "userId": str(current_user_id),
        "status": "read",
        "readAt": serialized_read_at,
    }


@router.get("/messages/{message_id}/receipts")
async def get_message_receipts(
    message_id: uuid.UUID,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    current_user_id = uuid.UUID(current_user["id"])

    result = await db.execute(select(Message).where(Message.id == message_id))
    message = result.scalar_one_or_none()
    if message is None:
        raise HTTPException(status_code=404, detail="Message not found")

    membership_result = await db.execute(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == message.conversation_id,
            ConversationParticipant.user_id == current_user_id,
        )
    )
    if membership_result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Message not found")

    result = await db.execute(
        select(MessageReceipt).where(MessageReceipt.message_id == message.id)
    )
    receipts = result.scalars().all()

    return {
        "messageId": str(message.id),
        "conversationId": str(message.conversation_id),
        "receipts": [
            {
                "userId": str(receipt.user_id),
                "status": "read" if receipt.read_at is not None else "unread",
                "readAt": receipt.read_at.isoformat() if receipt.read_at else None,
            }
            for receipt in receipts
        ],
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

    # Bound the body read before validation; upstream request-size limits should
    # also be configured in the ASGI server/reverse proxy for production.
    file_bytes = await file.read(MAX_FILE_SIZE + 1)

    if len(file_bytes) > MAX_FILE_SIZE:
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

    original_name = "".join(
        char for char in original_name
        if ord(char) >= 32 and ord(char) != 127
    )
    if len(original_name) > 255:
        raise HTTPException(
            status_code=400,
            detail="File names cannot exceed 255 characters.",
        )

    if len(caption) > 10_000:
        raise HTTPException(
            status_code=413,
            detail="Attachment captions cannot exceed 10,000 characters.",
        )

    # Determine MIME type from the extension and inspected file content. Never
    # persist a browser-supplied Content-Type without validation.
    content_type = validate_attachment_content(file_bytes, original_name)
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
        await db.flush()
        
        db.add(attachment)
        for recipient_id in participant_ids:
            if recipient_id != current_user_id:
                db.add(
                    MessageReceipt(
                        message_id=message_id,
                        user_id=recipient_id,
                        read_at=None,
                    )
                )
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
        "receipts": [
            {"userId": str(recipient_id), "status": "unread", "readAt": None}
            for recipient_id in participant_ids
            if recipient_id != current_user_id
        ],
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