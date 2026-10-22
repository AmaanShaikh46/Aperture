"""add persistent presence privacy and last-seen fields

Revision ID: 7a2d91e6c401
Revises: f13c8b2d94a1
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "7a2d91e6c401"
down_revision: Union[str, Sequence[str], None] = "f13c8b2d94a1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "profiles",
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "profiles",
        sa.Column("share_last_seen", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    op.drop_column("profiles", "share_last_seen")
    op.drop_column("profiles", "last_seen_at")
