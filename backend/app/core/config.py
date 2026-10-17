from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Aperture API"
    app_version: str = "0.1.0"
    database_url: str
    sql_echo: bool = False

    supabase_url: str
    supabase_secret_key: SecretStr
    supabase_publishable_key: str

    # Comma-separated browser origins allowed to call the API. Configure the
    # production frontend origin in the hosting provider's environment settings.
    # Do not use '*' while allow_credentials is enabled.
    cors_allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def cors_origins(self) -> list[str]:
        """Return normalized CORS origins from the comma-separated setting."""
        origins = (
            origin.strip().rstrip("/")
            for origin in self.cors_allowed_origins.split(",")
        )
        # Preserve order while removing blanks and duplicates.
        return list(dict.fromkeys(origin for origin in origins if origin))

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
    )


settings = Settings()
