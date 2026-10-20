import uuid
from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class FriendRequest(Base):
    """One current/historical request record per unordered pair of users."""

    __tablename__ = "friend_requests"
    __table_args__ = (
        UniqueConstraint("user_low_id", "user_high_id", name="uq_friend_requests_user_pair"),
        CheckConstraint("user_low_id < user_high_id", name="ck_friend_requests_canonical_pair"),
        CheckConstraint("sender_id <> recipient_id", name="ck_friend_requests_distinct_users"),
        CheckConstraint(
            "(sender_id = user_low_id AND recipient_id = user_high_id) OR "
            "(sender_id = user_high_id AND recipient_id = user_low_id)",
            name="ck_friend_requests_users_match_pair",
        ),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'rejected', 'cancelled')",
            name="ck_friend_requests_status",
        ),
        Index("ix_friend_requests_recipient_status", "recipient_id", "status"),
        Index("ix_friend_requests_sender_status", "sender_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4, server_default=func.gen_random_uuid())
    user_low_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    user_high_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    sender_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    recipient_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending", server_default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
        default=lambda: datetime.now(timezone.utc),
    )
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
