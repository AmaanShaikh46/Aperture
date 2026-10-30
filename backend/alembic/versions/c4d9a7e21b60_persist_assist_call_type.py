"""persist requested call type for Voice Assist commands

Revision ID: c4d9a7e21b60
Revises: b81e4f6a20c3
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c4d9a7e21b60"
down_revision: Union[str, Sequence[str], None] = "b81e4f6a20c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "assist_commands",
        sa.Column("call_type", sa.Text(), server_default="audio", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("assist_commands", "call_type")
