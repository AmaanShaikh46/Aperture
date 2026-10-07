import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class Profile(Base):
    __tablename__ = "profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True
    )

    username: Mapped[str | None] = mapped_column(
        Text,
        unique=True,
        nullable=True
    )

    display_name: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    avatar_url: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    bio: Mapped[str | None] = mapped_column(
        Text,
        nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False
    )