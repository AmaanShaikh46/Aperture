from functools import lru_cache

from supabase import Client, create_client

from app.core.config import settings


@lru_cache(maxsize=1)
def get_storage_client() -> Client:
    return create_client(
        settings.supabase_url,
        settings.supabase_secret_key.get_secret_value(),
    )