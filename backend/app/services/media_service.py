import uuid

from fastapi import HTTPException
from supabase import Client

from app.services.storage_service import get_storage_client


BUCKET_NAME = "aperture-media"
MAX_FILE_SIZE = 50 * 1024 * 1024


def upload_file(
    file_bytes: bytes,
    storage_path: str,
    content_type: str,
) -> None:
    if len(file_bytes) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 50 MB upload limit.",
        )

    client: Client = get_storage_client()

    try:
        client.storage.from_(BUCKET_NAME).upload(
            path=storage_path,
            file=file_bytes,
            file_options={
                "content-type": content_type,
                "upsert": "false",
            },
        )
    except Exception as exc:
        error_text = str(exc).lower()

        if any(
            term in error_text
            for term in (
                "storage quota",
                "storage limit",
                "quota exceeded",
                "maximum storage",
            )
        ):
            raise HTTPException(
                status_code=507,
                detail=(
                    "Storage is full. Your file couldn't be uploaded. "
                    "Please try again later."
                ),
            ) from exc

        raise HTTPException(
            status_code=502,
            detail="File upload failed. Please try again.",
        ) from exc


def create_storage_path(
    conversation_id: uuid.UUID,
    message_id: uuid.UUID,
    file_name: str,
) -> str:
    safe_name = file_name.replace("/", "_").replace("\\", "_").strip()

    if not safe_name:
        safe_name = "attachment"

    return f"{conversation_id}/{message_id}/{uuid.uuid4()}-{safe_name}"