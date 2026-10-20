import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint(
            "direct_user_low_id", "direct_user_high_id",
            name="uq_conversations_direct_pair",
        ),
        CheckConstraint(
            "(direct_user_low_id IS NULL AND direct_user_high_id IS NULL) OR "
            "(direct_user_low_id IS NOT NULL AND direct_user_high_id IS NOT NULL "
            "AND direct_user_low_id < direct_user_high_id)",
            name="ck_conversations_direct_pair_complete",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True,
        default=uuid.uuid4,
    )

    type: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="direct",
    )

    name: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
    )

    direct_user_low_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("profiles.id", name="fk_conversations_direct_low_profile", ondelete="CASCADE"), nullable=True
    )

    direct_user_high_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("profiles.id", name="fk_conversations_direct_high_profile", ondelete="CASCADE"), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=datetime.utcnow,
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=datetime.utcnow,
    )