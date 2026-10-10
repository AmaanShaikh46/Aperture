from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Aperture API"
    app_version: str = "0.1.0"
    database_url: str

    supabase_url: str
    supabase_secret_key: SecretStr
    supabase_publishable_key: str

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )


settings = Settings()