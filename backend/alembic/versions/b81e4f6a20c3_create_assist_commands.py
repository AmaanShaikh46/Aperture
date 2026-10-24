"""create persistent Voice Assist commands

Revision ID: b81e4f6a20c3
Revises: 7a2d91e6c401
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b81e4f6a20c3"
down_revision: Union[str, Sequence[str], None] = "7a2d91e6c401"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "assist_commands",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("transcript", sa.Text(), nullable=False),
        sa.Column("intent", sa.Text(), nullable=False),
        sa.Column("state", sa.Text(), server_default="pending_confirmation", nullable=False),
        sa.Column("recipient_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("message_content", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipient_id"], ["profiles.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_assist_commands_owner_state", "assist_commands", ["owner_id", "state"]
    )
    op.create_index(
        "ix_assist_commands_expires_at", "assist_commands", ["expires_at"]
    )

    # A unique, nullable command reference is the database-level idempotency
    # key. Ordinary messages/calls continue to use NULL and are unaffected.
    op.add_column("messages", sa.Column("assist_command_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_messages_assist_command_id",
        "messages", "assist_commands",
        ["assist_command_id"], ["id"], ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_messages_assist_command_id", "messages", ["assist_command_id"]
    )

    op.add_column("call_sessions", sa.Column("assist_command_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_call_sessions_assist_command_id",
        "call_sessions", "assist_commands",
        ["assist_command_id"], ["id"], ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_call_sessions_assist_command_id", "call_sessions", ["assist_command_id"]
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_call_sessions_assist_command_id", "call_sessions", type_="unique"
    )
    op.drop_constraint(
        "fk_call_sessions_assist_command_id", "call_sessions", type_="foreignkey"
    )
    op.drop_column("call_sessions", "assist_command_id")

    op.drop_constraint(
        "uq_messages_assist_command_id", "messages", type_="unique"
    )
    op.drop_constraint(
        "fk_messages_assist_command_id", "messages", type_="foreignkey"
    )
    op.drop_column("messages", "assist_command_id")

    op.drop_index("ix_assist_commands_expires_at", table_name="assist_commands")
    op.drop_index("ix_assist_commands_owner_state", table_name="assist_commands")
    op.drop_table("assist_commands")
