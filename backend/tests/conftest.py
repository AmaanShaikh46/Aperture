"""Unit-test setup that does not require a live database or external services."""

import os

# Settings are instantiated at import time by the application. These values are
# deliberately dummy values and are used only by isolated unit tests.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://unit:unit@127.0.0.1/unit")
os.environ.setdefault("SUPABASE_URL", "https://unit-test.invalid")
os.environ.setdefault("SUPABASE_SECRET_KEY", "unit-test-secret")
os.environ.setdefault("SUPABASE_PUBLISHABLE_KEY", "unit-test-public")

# Unit tests provide fake sessions and must never open an actual database engine.
import sqlalchemy.ext.asyncio as sqlalchemy_asyncio  # noqa: E402


class _NoDatabaseEngine:
    """Sentinel engine that makes accidental real DB use fail visibly."""

    def connect(self, *args, **kwargs):
        raise AssertionError("Unit tests must not connect to a real database.")


sqlalchemy_asyncio.create_async_engine = lambda *args, **kwargs: _NoDatabaseEngine()
