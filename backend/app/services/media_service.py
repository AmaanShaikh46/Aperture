"""Storage helpers and server-side attachment validation."""

import uuid
import warnings
from io import BytesIO
from pathlib import PurePath
from zipfile import BadZipFile, ZipFile

from fastapi import HTTPException, status
from PIL import Image, UnidentifiedImageError
from supabase import Client

from app.services.storage_service import get_storage_client


BUCKET_NAME = "aperture-media"
MAX_FILE_SIZE = 50 * 1024 * 1024
MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
MAX_OFFICE_ENTRIES = 10_000
MAX_OFFICE_UNCOMPRESSED_SIZE = 250 * 1024 * 1024

IMAGE_FORMATS = {
    ".jpg": ("JPEG", "image/jpeg"),
    ".jpeg": ("JPEG", "image/jpeg"),
    ".png": ("PNG", "image/png"),
    ".webp": ("WEBP", "image/webp"),
    ".gif": ("GIF", "image/gif"),
    ".bmp": ("BMP", "image/bmp"),
}
VIDEO_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
}
OFFICE_TYPES = {
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word/document.xml"),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xl/workbook.xml"),
    ".pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "ppt/presentation.xml"),
}
LEGACY_OFFICE_TYPES = {
    ".doc": "application/msword",
    ".ppt": "application/vnd.ms-powerpoint",
}
OLE_SIGNATURE = bytes.fromhex("D0CF11E0A1B11AE1")
EBML_SIGNATURE = bytes.fromhex("1A45DFA3")


def _unsupported_file(detail: str = "Unsupported or invalid attachment type.") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail=detail,
    )


def validate_attachment_content(file_bytes: bytes, file_name: str) -> str:
    """Return a canonical MIME type only after validating the file contents.

    The client-declared MIME type is deliberately not trusted. This is format
    validation, not malware scanning; users should still treat received files
    cautiously.
    """
    suffix = PurePath(file_name).suffix.lower()
    if not suffix:
        raise _unsupported_file("The attachment must have a supported file extension.")

    if suffix in IMAGE_FORMATS:
        expected_format, canonical_mime = IMAGE_FORMATS[suffix]
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(file_bytes)) as image:
                    if image.format != expected_format:
                        raise _unsupported_file("The image contents do not match the file extension.")
                    width, height = image.size
                    if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="Image dimensions are too large.",
                        )
                    image.verify()
        except HTTPException:
            raise
        except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise _unsupported_file("The file is not a valid supported image.") from exc
        return canonical_mime

    if suffix in VIDEO_TYPES:
        valid_video = False
        if suffix in {".mp4", ".m4v", ".mov"}:
            valid_video = len(file_bytes) >= 12 and file_bytes[4:8] == b"ftyp"
        elif suffix in {".webm", ".mkv"}:
            valid_video = file_bytes.startswith(EBML_SIGNATURE)
        elif suffix == ".avi":
            valid_video = len(file_bytes) >= 12 and file_bytes[:4] == b"RIFF" and file_bytes[8:12] == b"AVI "
        if not valid_video:
            raise _unsupported_file("The video contents do not match the file extension.")
        return VIDEO_TYPES[suffix]

    if suffix == ".pdf":
        if not file_bytes.startswith(b"%PDF-") or b"%%EOF" not in file_bytes[-2048:]:
            raise _unsupported_file("The file is not a valid PDF document.")
        return "application/pdf"

    if suffix in OFFICE_TYPES:
        expected_mime, required_member = OFFICE_TYPES[suffix]
        try:
            with ZipFile(BytesIO(file_bytes)) as package:
                entries = package.infolist()
                names = {entry.filename for entry in entries}
                if (
                    len(entries) > MAX_OFFICE_ENTRIES
                    or sum(entry.file_size for entry in entries) > MAX_OFFICE_UNCOMPRESSED_SIZE
                    or any(entry.flag_bits & 0x1 for entry in entries)
                    or "[Content_Types].xml" not in names
                    or required_member not in names
                ):
                    raise _unsupported_file("The Office document package is invalid or too large.")
        except HTTPException:
            raise
        except (BadZipFile, OSError, ValueError) as exc:
            raise _unsupported_file("The file is not a valid Office document.") from exc
        return expected_mime

    if suffix in LEGACY_OFFICE_TYPES:
        if not file_bytes.startswith(OLE_SIGNATURE):
            raise _unsupported_file("The file is not a valid legacy Office document.")
        return LEGACY_OFFICE_TYPES[suffix]

    if suffix in {".txt", ".csv"}:
        if len(file_bytes) > MAX_TEXT_FILE_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Text attachments cannot exceed 10 MB.",
            )
        try:
            text = file_bytes.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise _unsupported_file("Text and CSV attachments must use UTF-8 encoding.") from exc
        if "\x00" in text:
            raise _unsupported_file("Text and CSV files cannot contain binary data.")
        disallowed_controls = sum(
            1 for char in text
            if ord(char) < 32 and char not in "\t\r\n\f"
        )
        if disallowed_controls > max(4, len(text) // 1000):
            raise _unsupported_file("The text attachment contains unsupported control characters.")
        return "text/csv; charset=utf-8" if suffix == ".csv" else "text/plain; charset=utf-8"

    raise _unsupported_file("This file format is not supported.")


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
    safe_name = "".join(char for char in safe_name if ord(char) >= 32 and ord(char) != 127)
    safe_name = safe_name[:180]

    if not safe_name:
        safe_name = "attachment"

    return f"{conversation_id}/{message_id}/{uuid.uuid4()}-{safe_name}"
