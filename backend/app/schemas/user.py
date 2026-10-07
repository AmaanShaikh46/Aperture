from pydantic import BaseModel


class ProfileUpdate(BaseModel):
    username: str | None = None
    display_name: str | None = None
    avatar_url: str | None = None
    bio: str | None = None

class UserSearchResult(BaseModel):
    id: str
    username: str | None
    display_name: str | None
    avatar_url: str | None