"""The plain system status that every signed-in person may read."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

PartKey = Literal["data", "signing_in", "files", "email"]
PartStatus = Literal["working", "not_working", "not_set_up", "set_up"]


class SystemPart(BaseModel):
    key: PartKey
    status: PartStatus


class SystemStatusResponse(BaseModel):
    parts: list[SystemPart]
    version: str
    checked_at: datetime
