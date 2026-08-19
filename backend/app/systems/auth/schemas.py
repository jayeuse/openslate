from typing import Annotated

from pydantic import BaseModel, Field, field_validator


class RegistrationRequest(BaseModel):
    username: Annotated[str, Field(min_length=3, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")]
    password: Annotated[str, Field(min_length=12, max_length=128)]

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        return value.lower()


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
