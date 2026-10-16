from datetime import datetime

from pydantic import BaseModel


class RealtimeTokenRead(BaseModel):
    access_token: str
    expires_at: datetime
    topic_prefix: str
