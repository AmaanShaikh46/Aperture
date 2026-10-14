"""User/profile request and response schemas."""

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProfileUpdate(BaseModel):
    """Editable profile fields. Avatar changes use the dedicated upload endpoint."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
    )

    username: str | None = Field(default=None, max_length=30)
    display_name: str | None = Field(default=None, alias="displayName", max_length=80)
    bio: str | None = Field(default=None, max_length=250)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_username(cls, value: Any) -> Any:
        if value is None:
            return None
        if not isinstance(value, str):
            return value
        value = value.strip().lower()
        return value or None

    @field_validator("username")
    @classmethod
    def validate_username(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) < 3:
            raise ValueError("Username must contain at least 3 characters.")
        if not re.fullmatch(r"[a-z0-9_]+", value):
            raise ValueError("Username may contain only letters, numbers, and underscores.")
        return value

    @field_validator("display_name", mode="before")
    @classmethod
    def normalize_display_name(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("display_name")
    @classmethod
    def require_display_name(cls, value: str | None) -> str | None:
        if value is not None and not value:
            raise ValueError("Display name cannot be empty.")
        return value

    @field_validator("bio", mode="before")
    @classmethod
    def normalize_bio(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip() or None
        return value


class UserSearchResult(BaseModel):
    """Public profile fields returned by user search."""

    model_config = ConfigDict(populate_by_name=True)

    id: str
    username: str | None
    display_name: str | None = Field(alias="displayName")
    avatar_url: str | None = Field(alias="avatarUrl")
