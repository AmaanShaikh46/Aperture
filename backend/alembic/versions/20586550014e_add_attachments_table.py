"""add attachments table

Revision ID: 20586550014e
Revises: 5dddd85cbf87
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20586550014e"
down_revision: Union[str, Sequence[str], None] = "5dddd85cbf87"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("file_name", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.Text(), nullable=False),
        sa.Column("file_size", sa.BigInteger(), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["messages.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_path"),
    )

    op.create_index(
        "ix_attachments_message_id",
        "attachments",
        ["message_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_attachments_message_id",
        table_name="attachments",
    )
    op.drop_table("attachments")