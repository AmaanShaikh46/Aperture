"""add mutual friendships, friend requests, and unique direct conversations

Revision ID: f13c8b2d94a1
Revises: e7b3c1a90f42
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f13c8b2d94a1"
down_revision: Union[str, Sequence[str], None] = "e7b3c1a90f42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # One canonical row represents a mutual friendship, regardless of which
    # user initiated the original conversation or contact action.
    op.create_table(
        "friendships",
        sa.Column("id", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_low_id", sa.UUID(), nullable=False),
        sa.Column("user_high_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("user_low_id < user_high_id", name="ck_friendships_canonical_pair"),
        sa.ForeignKeyConstraint(["user_low_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_high_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_low_id", "user_high_id", name="uq_friendships_user_pair"),
    )
    op.create_index("ix_friendships_user_low", "friendships", ["user_low_id"])
    op.create_index("ix_friendships_user_high", "friendships", ["user_high_id"])

    op.create_table(
        "friend_requests",
        sa.Column("id", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_low_id", sa.UUID(), nullable=False),
        sa.Column("user_high_id", sa.UUID(), nullable=False),
        sa.Column("sender_id", sa.UUID(), nullable=False),
        sa.Column("recipient_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("user_low_id < user_high_id", name="ck_friend_requests_canonical_pair"),
        sa.CheckConstraint("sender_id <> recipient_id", name="ck_friend_requests_distinct_users"),
        sa.CheckConstraint(
            "(sender_id = user_low_id AND recipient_id = user_high_id) OR "
            "(sender_id = user_high_id AND recipient_id = user_low_id)",
            name="ck_friend_requests_users_match_pair",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'accepted', 'rejected', 'cancelled')",
            name="ck_friend_requests_status",
        ),
        sa.ForeignKeyConstraint(["user_low_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_high_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["sender_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["recipient_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_low_id", "user_high_id", name="uq_friend_requests_user_pair"),
    )
    op.create_index("ix_friend_requests_recipient_status", "friend_requests", ["recipient_id", "status"])
    op.create_index("ix_friend_requests_sender_status", "friend_requests", ["sender_id", "status"])

    # These nullable columns uniquely identify a direct conversation. Groups
    # keep both columns NULL, which PostgreSQL permits under a UNIQUE constraint.
    op.add_column("conversations", sa.Column("direct_user_low_id", sa.UUID(), nullable=True))
    op.add_column("conversations", sa.Column("direct_user_high_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "fk_conversations_direct_low_profile",
        "conversations", "profiles", ["direct_user_low_id"], ["id"], ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_conversations_direct_high_profile",
        "conversations", "profiles", ["direct_user_high_id"], ["id"], ondelete="CASCADE",
    )

    # These indexes serve hot paths in the chat list and message history APIs.
    # conversation_participants is keyed by (conversation_id, user_id), so the
    # reverse user lookup needs its own index. The message index supports a
    # latest-message lookup per conversation without scanning message history.
    op.create_index(
        "ix_conversation_participants_user_id",
        "conversation_participants",
        ["user_id"],
    )
    op.create_index(
        "ix_messages_conversation_created_at",
        "messages",
        ["conversation_id", "created_at", "id"],
    )

    # Consolidate existing duplicate direct conversations before adding the
    # uniqueness constraint. The survivor is selected by most messages, then
    # latest activity, then earliest creation time. All message rows are moved;
    # message IDs, receipts, and attachments therefore remain unchanged.
    op.execute("""
        CREATE TEMPORARY TABLE _aperture_direct_merges ON COMMIT DROP AS
        WITH pair_rows AS (
            SELECT
                c.id AS conversation_id,
                cp_low.user_id AS user_low_id,
                cp_high.user_id AS user_high_id,
                COUNT(DISTINCT m.id) AS message_count,
                c.created_at,
                c.updated_at
            FROM conversations AS c
            JOIN conversation_participants AS cp_low
              ON cp_low.conversation_id = c.id
            JOIN conversation_participants AS cp_high
              ON cp_high.conversation_id = c.id
             AND cp_low.user_id < cp_high.user_id
            LEFT JOIN messages AS m ON m.conversation_id = c.id
            WHERE c.type = 'direct'
              AND (SELECT COUNT(*) FROM conversation_participants x WHERE x.conversation_id = c.id) = 2
            GROUP BY c.id, cp_low.user_id, cp_high.user_id, c.created_at, c.updated_at
        ), ranked AS (
            SELECT
                conversation_id,
                user_low_id,
                user_high_id,
                FIRST_VALUE(conversation_id) OVER (
                    PARTITION BY user_low_id, user_high_id
                    ORDER BY message_count DESC, updated_at DESC, created_at ASC, conversation_id ASC
                ) AS survivor_id
            FROM pair_rows
        )
        SELECT conversation_id AS duplicate_id, survivor_id
        FROM ranked
        WHERE conversation_id <> survivor_id
    """)

    op.execute("""
        UPDATE messages AS m
        SET conversation_id = merges.survivor_id
        FROM _aperture_direct_merges AS merges
        WHERE m.conversation_id = merges.duplicate_id
    """)

    op.execute("""
        UPDATE conversations AS survivor
        SET updated_at = GREATEST(
            survivor.updated_at,
            (SELECT MAX(duplicate.updated_at)
             FROM _aperture_direct_merges AS merges
             JOIN conversations AS duplicate ON duplicate.id = merges.duplicate_id
             WHERE merges.survivor_id = survivor.id)
        )
        WHERE survivor.id IN (SELECT survivor_id FROM _aperture_direct_merges)
    """)

    op.execute("""
        DELETE FROM conversations AS c
        USING _aperture_direct_merges AS merges
        WHERE c.id = merges.duplicate_id
    """)

    # Do not silently leave malformed direct chats outside the canonical-pair
    # constraint. Empty abandoned shells can be removed safely; conversations
    # with messages must be manually reconciled rather than losing history.
    op.execute("""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1
                FROM conversations AS c
                WHERE c.type = 'direct'
                  AND (SELECT COUNT(*) FROM conversation_participants cp
                       WHERE cp.conversation_id = c.id) <> 2
                  AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
            ) THEN
                RAISE EXCEPTION
                    'Friendship migration stopped: a direct conversation with message history does not have exactly two participants. Reconcile those rows before retrying.';
            END IF;
        END $$;
    """)

    op.execute("""
        DELETE FROM conversations AS c
        WHERE c.type = 'direct'
          AND (SELECT COUNT(*) FROM conversation_participants cp
               WHERE cp.conversation_id = c.id) <> 2
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
    """)

    # Populate canonical pairs for every ordinary one-to-one conversation.
    op.execute("""
        UPDATE conversations AS c
        SET direct_user_low_id = pair.user_low_id,
            direct_user_high_id = pair.user_high_id
        FROM (
            SELECT cp_low.conversation_id,
                   cp_low.user_id AS user_low_id,
                   cp_high.user_id AS user_high_id
            FROM conversation_participants AS cp_low
            JOIN conversation_participants AS cp_high
              ON cp_high.conversation_id = cp_low.conversation_id
             AND cp_low.user_id < cp_high.user_id
            JOIN conversations AS target ON target.id = cp_low.conversation_id
            WHERE target.type = 'direct'
              AND (SELECT COUNT(*) FROM conversation_participants x
                   WHERE x.conversation_id = target.id) = 2
        ) AS pair
        WHERE c.id = pair.conversation_id
    """)

    # Legacy conversations that already contain messages are grandfathered as
    # friendships so current users do not unexpectedly lose established DMs.
    op.execute("""
        INSERT INTO friendships (user_low_id, user_high_id, created_at)
        SELECT c.direct_user_low_id, c.direct_user_high_id, MIN(m.created_at)
        FROM conversations AS c
        JOIN messages AS m ON m.conversation_id = c.id
        WHERE c.type = 'direct'
          AND c.direct_user_low_id IS NOT NULL
          AND c.direct_user_high_id IS NOT NULL
        GROUP BY c.direct_user_low_id, c.direct_user_high_id
        ON CONFLICT (user_low_id, user_high_id) DO NOTHING
    """)

    # Reciprocal legacy contacts indicate that both users added each other, so
    # they become accepted friendships rather than one-sided requests.
    op.execute("""
        INSERT INTO friendships (user_low_id, user_high_id, created_at)
        SELECT
            LEAST(c.user_id, reciprocal.user_id),
            GREATEST(c.user_id, reciprocal.user_id),
            MIN(LEAST(c.created_at, reciprocal.created_at))
        FROM contacts AS c
        JOIN contacts AS reciprocal
          ON reciprocal.user_id = c.contact_user_id
         AND reciprocal.contact_user_id = c.user_id
        WHERE c.user_id <> c.contact_user_id
        GROUP BY LEAST(c.user_id, reciprocal.user_id), GREATEST(c.user_id, reciprocal.user_id)
        ON CONFLICT (user_low_id, user_high_id) DO NOTHING
    """)

    # One-sided legacy contacts become pending requests. No user is made a
    # friend merely because another user unilaterally added them.
    op.execute("""
        INSERT INTO friend_requests (
            user_low_id, user_high_id, sender_id, recipient_id, status, created_at
        )
        SELECT
            LEAST(c.user_id, c.contact_user_id),
            GREATEST(c.user_id, c.contact_user_id),
            c.user_id,
            c.contact_user_id,
            'pending',
            MIN(c.created_at)
        FROM contacts AS c
        WHERE c.user_id <> c.contact_user_id
          AND NOT EXISTS (
              SELECT 1 FROM friendships f
              WHERE f.user_low_id = LEAST(c.user_id, c.contact_user_id)
                AND f.user_high_id = GREATEST(c.user_id, c.contact_user_id)
          )
          AND NOT EXISTS (
              SELECT 1 FROM contacts reciprocal
              WHERE reciprocal.user_id = c.contact_user_id
                AND reciprocal.contact_user_id = c.user_id
          )
        GROUP BY c.user_id, c.contact_user_id
        ON CONFLICT (user_low_id, user_high_id) DO NOTHING
    """)

    # Empty direct conversations for people who are not friends are not usable
    # chats. Remove these shells; requests and all non-empty message history are
    # preserved. The frontend will show request actions instead.
    op.execute("""
        DELETE FROM conversations AS c
        WHERE c.type = 'direct'
          AND c.direct_user_low_id IS NOT NULL
          AND c.direct_user_high_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
          AND NOT EXISTS (
              SELECT 1 FROM friendships f
              WHERE f.user_low_id = c.direct_user_low_id
                AND f.user_high_id = c.direct_user_high_id
          )
    """)

    op.create_check_constraint(
        "ck_conversations_direct_pair_complete",
        "conversations",
        "(direct_user_low_id IS NULL AND direct_user_high_id IS NULL) OR "
        "(direct_user_low_id IS NOT NULL AND direct_user_high_id IS NOT NULL "
        "AND direct_user_low_id < direct_user_high_id)",
    )
    op.create_unique_constraint(
        "uq_conversations_direct_pair",
        "conversations",
        ["direct_user_low_id", "direct_user_high_id"],
    )

    # Compatibility guard for old application instances that still create a
    # conversation row before inserting its participants and do not know about
    # the new canonical-pair columns. Once the second participant is inserted,
    # fill those columns so the unique constraint still prevents duplicate DMs.
    op.execute("""
        CREATE OR REPLACE FUNCTION aperture_set_direct_conversation_pair()
        RETURNS trigger AS $$
        DECLARE
            conversation_type text;
            participant_count integer;
            low_user_id uuid;
            high_user_id uuid;
        BEGIN
            SELECT type INTO conversation_type
            FROM conversations
            WHERE id = NEW.conversation_id;

            IF conversation_type IS DISTINCT FROM 'direct' THEN
                RETURN NEW;
            END IF;

            SELECT COUNT(*) INTO participant_count
            FROM conversation_participants
            WHERE conversation_id = NEW.conversation_id;

            IF participant_count = 2 THEN
                SELECT user_id INTO low_user_id
                FROM conversation_participants
                WHERE conversation_id = NEW.conversation_id
                ORDER BY user_id ASC
                LIMIT 1;

                SELECT user_id INTO high_user_id
                FROM conversation_participants
                WHERE conversation_id = NEW.conversation_id
                ORDER BY user_id DESC
                LIMIT 1;

                UPDATE conversations
                SET direct_user_low_id = low_user_id,
                    direct_user_high_id = high_user_id
                WHERE id = NEW.conversation_id
                  AND direct_user_low_id IS NULL
                  AND direct_user_high_id IS NULL;
            END IF;

            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)
    op.execute("""
        CREATE TRIGGER trg_aperture_direct_conversation_pair
        AFTER INSERT ON conversation_participants
        FOR EACH ROW
        EXECUTE FUNCTION aperture_set_direct_conversation_pair()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS trg_aperture_direct_conversation_pair ON conversation_participants")
    op.execute("DROP FUNCTION IF EXISTS aperture_set_direct_conversation_pair()")
    # The schema can be downgraded, but merged duplicate conversation rows and
    # relationship backfills are intentionally not reversed because doing so
    # would require reconstructing prior data from history.
    op.drop_constraint("uq_conversations_direct_pair", "conversations", type_="unique")
    op.drop_constraint("ck_conversations_direct_pair_complete", "conversations", type_="check")
    op.drop_constraint("fk_conversations_direct_high_profile", "conversations", type_="foreignkey")
    op.drop_constraint("fk_conversations_direct_low_profile", "conversations", type_="foreignkey")
    op.drop_index("ix_messages_conversation_created_at", table_name="messages")
    op.drop_index("ix_conversation_participants_user_id", table_name="conversation_participants")
    op.drop_column("conversations", "direct_user_high_id")
    op.drop_column("conversations", "direct_user_low_id")
    op.drop_index("ix_friend_requests_sender_status", table_name="friend_requests")
    op.drop_index("ix_friend_requests_recipient_status", table_name="friend_requests")
    op.drop_table("friend_requests")
    op.drop_index("ix_friendships_user_high", table_name="friendships")
    op.drop_index("ix_friendships_user_low", table_name="friendships")
    op.drop_table("friendships")
