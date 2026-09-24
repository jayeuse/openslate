"""Bounded, display-only HTTP(S) links for Board content."""

from typing import Self

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, model_validator


class ContentLink(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    label: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=2048)

    @model_validator(mode="after")
    def safe_http_url(self) -> Self:
        parsed = AnyHttpUrl(self.url)
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("Link URLs cannot contain credentials")
        self.url = str(parsed)
        if len(self.url) > 2048:
            raise ValueError("Link URL is too long")
        return self
