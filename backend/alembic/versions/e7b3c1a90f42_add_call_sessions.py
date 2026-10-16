"""add authenticated one-to-one call sessions

Revision ID: e7b3c1a90f42
Revises: d25e4c9a0b31
Create Date: 2026-10-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e7b3c1a90f42"
down_revision: Union[str, Sequence[str], None] = "d25e4c9a0b31"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "call_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("caller_id", sa.Uuid(), nullable=False),
        sa.Column("callee_id", sa.Uuid(), nullable=False),
        sa.Column("call_type", sa.Text(), server_default="audio", nullable=False),
        sa.Column("status", sa.Text(), server_default="ringing", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["caller_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["callee_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["ended_by"], ["profiles.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("caller_id <> callee_id", name="ck_call_sessions_distinct_participants"),
        sa.CheckConstraint("call_type IN ('audio', 'video')", name="ck_call_sessions_call_type"),
        sa.CheckConstraint(
            "status IN ('ringing', 'accepted', 'rejected', 'completed', 'cancelled', 'missed')",
            name="ck_call_sessions_status",
        ),
    )
    op.create_index("ix_call_sessions_caller_created", "call_sessions", ["caller_id", "created_at"])
    op.create_index("ix_call_sessions_callee_created", "call_sessions", ["callee_id", "created_at"])
    op.create_index("ix_call_sessions_status_created", "call_sessions", ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_call_sessions_status_created", table_name="call_sessions")
    op.drop_index("ix_call_sessions_callee_created", table_name="call_sessions")
    op.drop_index("ix_call_sessions_caller_created", table_name="call_sessions")
    op.drop_table("call_sessions")
