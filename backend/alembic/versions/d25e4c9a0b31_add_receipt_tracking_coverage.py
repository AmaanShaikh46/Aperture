"""add explicit per-message receipt tracking coverage

Revision ID: d25e4c9a0b31
Revises: a7b4d83cf120
Create Date: 2026-10-16
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d25e4c9a0b31"
down_revision: Union[str, Sequence[str], None] = "a7b4d83cf120"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Existing messages are explicitly marked untracked. New application
    # message creation paths set this flag true after creating all recipient rows.
    op.add_column(
        "messages",
        sa.Column(
            "receipt_tracking_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("messages", "receipt_tracking_enabled")
