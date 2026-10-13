"""add group conversation fields

Revision ID: 9df961d151dc
Revises: 20586550014e
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "9df961d151dc"
down_revision: Union[str, Sequence[str], None] = "20586550014e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add the optional group name.
    op.add_column(
        "conversations",
        sa.Column("name", sa.Text(), nullable=True),
    )

    # Add role with a temporary server-side default so existing
    # conversation participants receive the "member" role.
    op.add_column(
        "conversation_participants",
        sa.Column(
            "role",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'member'"),
        ),
    )

    # Remove the server-side default after existing rows are populated.
    # Future inserts must specify the appropriate role explicitly.
    op.alter_column(
        "conversation_participants",
        "role",
        server_default=None,
    )


def downgrade() -> None:
    op.drop_column("conversation_participants", "role")
    op.drop_column("conversations", "name")