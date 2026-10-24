import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base


class CallSession(Base):
    """Persisted one-to-one audio/video call state for Aperture."""

    __tablename__ = "call_sessions"
    __table_args__ = (
        Index("ix_call_sessions_caller_created", "caller_id", "created_at"),
        Index("ix_call_sessions_callee_created", "callee_id", "created_at"),
        Index("ix_call_sessions_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    caller_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    callee_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    assist_command_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("assist_commands.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
    )
    call_type: Mapped[str] = mapped_column(Text, nullable=False, default="audio", server_default="audio")
    status: Mapped[str] = mapped_column(Text, nullable=False, default="ringing", server_default="ringing")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
