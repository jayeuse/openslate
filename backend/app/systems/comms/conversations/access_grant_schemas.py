"""D45 access grant wire shapes for channel and category targets."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from app.systems.comms.conversations.schemas import MemberDepartment
from app.systems.comms.direct_candidates import DirectCandidateQuery
from app.systems.comms.messages.schemas import WireModel

Subject = Literal["group", "user"]
GrantLevel = Literal["read", "post"]


class AccessGrant(WireModel):
    subject: Subject
    subject_id: UUID
    display_name: str
    # A person's departments, so a manager can tell people apart; null for a group.
    departments: list[MemberDepartment] | None = None
    level: GrantLevel
    source: Literal["channel", "category"]
    created_at: datetime
    updated_at: datetime


class AccessGrants(WireModel):
    items: list[AccessGrant]


class AccessGrantRequest(WireModel):
    level: GrantLevel


class AccessCandidateQuery(DirectCandidateQuery):
    kind: Subject | None = None


class PersonCandidate(WireModel):
    user_id: UUID
    display_name: str
    departments: list[MemberDepartment]


class GroupCandidate(WireModel):
    id: UUID
    name: str


class AccessCandidates(WireModel):
    people: list[PersonCandidate]
    groups: list[GroupCandidate]
