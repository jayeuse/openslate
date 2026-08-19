from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from app.systems.users.models import UserRole


class UserResponse(BaseModel):
    id: UUID
    username: str
    role: UserRole
    is_active: bool
    preferences: dict[str, object]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
