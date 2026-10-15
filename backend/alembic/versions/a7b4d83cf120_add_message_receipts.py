"""add per-recipient message read receipts

Revision ID: a7b4d83cf120
Revises: 9df961d151dc
Create Date: 2026-10-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7b4d83cf120"
down_revision: Union[str, Sequence[str], None] = "9df961d151dc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "message_receipts",
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("message_id", "user_id"),
    )
    op.create_index(
        "ix_message_receipts_user_id",
        "message_receipts",
        ["user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_message_receipts_user_id", table_name="message_receipts")
    op.drop_table("message_receipts")
