from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.api.calls import _lock_call_participants


class LockResult:
    def __init__(self, scalar):
        self.scalar = scalar

    def scalar_one_or_none(self):
        return self.scalar


class LockSession:
    def __init__(self, results):
        self.results = list(results)
        self.statements = []

    async def execute(self, statement):
        self.statements.append(statement)
        if not self.results:
            raise AssertionError("Unexpected database query")
        return self.results.pop(0)


@pytest.mark.asyncio
async def test_lock_call_participants_locks_unique_ids_in_sorted_order():
    first, second, third = sorted((uuid.uuid4(), uuid.uuid4(), uuid.uuid4()), key=lambda item: item.int)
    db = LockSession([
        LockResult(first),
        LockResult(second),
        LockResult(third),
    ])

    await _lock_call_participants(db, third, first, second, first)

    assert len(db.statements) == 3
    for statement, expected_id in zip(db.statements, (first, second, third)):
        sql = str(statement.compile(dialect=postgresql.dialect()))
        assert "FOR UPDATE" in sql.upper()
        assert statement.compile().params["id_1"] == expected_id


@pytest.mark.asyncio
async def test_lock_call_participants_raises_404_for_missing_profile():
    first, missing = sorted((uuid.uuid4(), uuid.uuid4()), key=lambda item: item.int)
    db = LockSession([LockResult(first), LockResult(None)])

    with pytest.raises(HTTPException) as exc:
        await _lock_call_participants(db, missing, first)

    assert exc.value.status_code == 404
    assert len(db.statements) == 2
