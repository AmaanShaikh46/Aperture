"""Read-only preflight checks for the friendship migration.

Run from the backend directory after setting DATABASE_URL in .env:
    python scripts/friendship_migration_preflight.py

This script opens a read-only transaction and never changes application data.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Support running the file directly from the backend directory on Windows.
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import text

from app.database.database import engine


async def main() -> int:
    blockers = 0
    expected_revision = "e7b3c1a90f42"
    async with engine.connect() as connection:
        async with connection.begin():
            # PostgreSQL rejects accidental INSERT/UPDATE/DELETE in this check.
            await connection.execute(text("SET TRANSACTION READ ONLY"))

            version_table_exists = await connection.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = current_schema() AND table_name = 'alembic_version')"
                )
            )
            if version_table_exists:
                versions = (
                    await connection.execute(text("SELECT version_num FROM alembic_version ORDER BY version_num"))
                ).scalars().all()
                print("Alembic revision:", ", ".join(versions) if versions else "<empty>")
                if versions != [expected_revision]:
                    print(
                        "  BLOCKER: expected the database to be exactly at revision "
                        f"{expected_revision!r} before applying the friendship migration."
                    )
                    blockers += 1
            else:
                print("Alembic revision: no alembic_version table found")
                print("  BLOCKER: this preflight expects an existing database at the migration predecessor revision.")
                blockers += 1

            uuid_function = await connection.scalar(text("SELECT to_regprocedure('gen_random_uuid()') IS NOT NULL"))
            print("gen_random_uuid() available:", bool(uuid_function))

            malformed_rows = (
                await connection.execute(
                    text(
                        "SELECT c.id, "
                        "(SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id) AS participant_count, "
                        "(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count "
                        "FROM conversations c "
                        "WHERE c.type = 'direct' "
                        "AND (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id) <> 2 "
                        "ORDER BY (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) DESC, c.created_at"
                    )
                )
            ).all()
            malformed_with_history = [row for row in malformed_rows if row.message_count > 0]
            malformed_empty = [row for row in malformed_rows if row.message_count == 0]

            print(f"Malformed direct conversations with message history: {len(malformed_with_history)}")
            for row in malformed_with_history:
                print(
                    f"  BLOCKER conversation={row.id} participants={row.participant_count} "
                    f"messages={row.message_count}"
                )
            print(f"Empty malformed direct-conversation shells: {len(malformed_empty)}")
            for row in malformed_empty:
                print(f"  Will be removed by migration: conversation={row.id}, participants={row.participant_count}")

            duplicate_rows = (
                await connection.execute(
                    text(
                        "WITH pair_rows AS ("
                        " SELECT c.id AS conversation_id, cp_low.user_id AS user_low_id, "
                        "        cp_high.user_id AS user_high_id, c.created_at, c.updated_at, "
                        "        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count, "
                        "        (SELECT COUNT(*) FROM attachments a JOIN messages m ON m.id = a.message_id "
                        "         WHERE m.conversation_id = c.id) AS attachment_count, "
                        "        (SELECT COUNT(*) FROM message_receipts r JOIN messages m ON m.id = r.message_id "
                        "         WHERE m.conversation_id = c.id) AS receipt_count "
                        " FROM conversations c "
                        " JOIN conversation_participants cp_low ON cp_low.conversation_id = c.id "
                        " JOIN conversation_participants cp_high ON cp_high.conversation_id = c.id "
                        "      AND cp_low.user_id < cp_high.user_id "
                        " WHERE c.type = 'direct' "
                        "   AND (SELECT COUNT(*) FROM conversation_participants cp "
                        "        WHERE cp.conversation_id = c.id) = 2"
                        ") "
                        "SELECT user_low_id, user_high_id, COUNT(*) AS conversation_count, "
                        "       ARRAY_AGG(conversation_id ORDER BY message_count DESC, updated_at DESC, created_at ASC, conversation_id ASC) AS conversation_ids, "
                        "       SUM(message_count) AS messages, SUM(attachment_count) AS attachments, "
                        "       SUM(receipt_count) AS receipts "
                        "FROM pair_rows GROUP BY user_low_id, user_high_id HAVING COUNT(*) > 1 "
                        "ORDER BY COUNT(*) DESC"
                    )
                )
            ).all()
            print(f"Duplicate direct-conversation pairs to consolidate: {len(duplicate_rows)}")
            for row in duplicate_rows:
                print(
                    f"  pair={row.user_low_id}/{row.user_high_id}; conversations={row.conversation_count}; "
                    f"messages={row.messages}; attachments={row.attachments}; receipts={row.receipts}; "
                    f"ids={row.conversation_ids}"
                )

            foreign_key_rows = (
                await connection.execute(
                    text(
                        "SELECT tc.table_name, kcu.column_name, tc.constraint_name "
                        "FROM information_schema.table_constraints tc "
                        "JOIN information_schema.key_column_usage kcu "
                        " ON tc.constraint_catalog = kcu.constraint_catalog "
                        "AND tc.constraint_schema = kcu.constraint_schema "
                        "AND tc.constraint_name = kcu.constraint_name "
                        "JOIN information_schema.constraint_column_usage ccu "
                        " ON ccu.constraint_catalog = tc.constraint_catalog "
                        "AND ccu.constraint_schema = tc.constraint_schema "
                        "AND ccu.constraint_name = tc.constraint_name "
                        "WHERE tc.constraint_type = 'FOREIGN KEY' "
                        "AND tc.table_schema = current_schema() "
                        "AND ccu.table_schema = current_schema() "
                        "AND ccu.table_name = 'conversations' "
                        "ORDER BY tc.table_name, kcu.column_name"
                    )
                )
            ).all()
            print("Foreign-key references to conversations:")
            for row in foreign_key_rows:
                print(f"  {row.table_name}.{row.column_name} ({row.constraint_name})")

            blockers += len(malformed_with_history)
            if not uuid_function:
                print("  BLOCKER: PostgreSQL function gen_random_uuid() is unavailable.")
                blockers += 1
            unexpected_foreign_keys = [
                row for row in foreign_key_rows
                if row.table_name not in {"conversation_participants", "messages"}
            ]
            if unexpected_foreign_keys:
                print("  BLOCKER: unexpected tables reference conversations and need migration review:")
                for row in unexpected_foreign_keys:
                    print(f"    {row.table_name}.{row.column_name} ({row.constraint_name})")
                blockers += len(unexpected_foreign_keys)
            if blockers:
                print(f"PREFLIGHT FAILED: {blockers} blocker(s). Do not run the migration yet.")
            else:
                print("PREFLIGHT PASSED: no malformed direct conversations with history were found.")
                print("This is a data preflight, not a substitute for a backup and staging migration test.")

    await engine.dispose()
    return 1 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
