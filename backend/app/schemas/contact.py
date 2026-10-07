from pydantic import BaseModel


class ContactCreate(BaseModel):
    contact_user_id: str