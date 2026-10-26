"""Wire shapes of a Board's Kanban: stages, labels, cards, checklists and their reads."""

from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.common.listing import SortOrder, StandardListRequest, StandardListResponse
from app.systems.manage.audit.models import AuditAction

Color = Literal["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]
CardSortMode = Literal["manual", "due", "newest", "title"]
Revision = Annotated[int, Field(ge=1)]


def _unique(values: list[UUID]) -> list[UUID]:
    if len(set(values)) != len(values):
        raise ValueError("IDs must be distinct")
    return values


def _no_null(payload: BaseModel, *names: str) -> None:
    for name in names:
        if name in payload.model_fields_set and getattr(payload, name) is None:
            raise ValueError(f"{name} cannot be null")


def _ordered(start_on: date | None, due_on: date | None) -> None:
    if start_on is not None and due_on is not None and start_on > due_on:
        raise ValueError("start_on must not be after due_on")


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class RevisionWrite(_Input):
    revision: Revision


# Stages


class StageCreate(_Input):
    name: str = Field(min_length=1, max_length=60)
    color: Color | None = None
    wip_limit: int | None = Field(default=None, ge=1, le=999)
    card_sort: CardSortMode = "manual"


class StagePatch(_Input):
    revision: Revision
    name: str | None = Field(default=None, min_length=1, max_length=60)
    color: Color | None = None
    wip_limit: int | None = Field(default=None, ge=1, le=999)
    card_sort: CardSortMode | None = None

    @model_validator(mode="after")
    def required_values(self) -> Self:
        _no_null(self, "name", "card_sort")
        return self


class StageOrder(_Input):
    stage_ids: list[UUID] = Field(min_length=1, max_length=20)

    @field_validator("stage_ids")
    @classmethod
    def distinct_ids(cls, value: list[UUID]) -> list[UUID]:
        return _unique(value)


class StageArchive(_Input):
    revision: Revision
    cards: Literal["move", "archive"]
    target_stage_id: UUID | None = None

    @model_validator(mode="after")
    def target_for_move(self) -> Self:
        if (self.cards == "move") != (self.target_stage_id is not None):
            raise ValueError("target_stage_id is required to move cards, and only then")
        return self


class StageSort(StrEnum):
    POSITION = "position"


class StageListRequest(StandardListRequest[StageSort]):
    limit: int = Field(default=20, ge=1, le=100)


class StageResponse(BaseModel):
    id: UUID
    board_id: UUID
    name: str
    color: Color | None
    wip_limit: int | None
    card_sort: CardSortMode
    position: int
    revision: int
    archived_at: datetime | None
    card_count: int


class StageListResponse(StandardListResponse[StageResponse]):
    pass


class StageItems(BaseModel):
    items: list[StageResponse]


# Labels


class LabelCreate(_Input):
    name: str = Field(min_length=1, max_length=40)
    color: Color


class LabelPatch(_Input):
    revision: Revision
    name: str | None = Field(default=None, min_length=1, max_length=40)
    color: Color | None = None

    @model_validator(mode="after")
    def required_values(self) -> Self:
        _no_null(self, "name", "color")
        return self


class LabelSort(StrEnum):
    POSITION = "position"
    NAME = "name"


class LabelListRequest(StandardListRequest[LabelSort]):
    limit: int = Field(default=20, ge=1, le=100)


class LabelResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    board_id: UUID
    name: str
    color: Color
    position: int
    revision: int


class LabelListResponse(StandardListResponse[LabelResponse]):
    pass


# Cards


class _CardValues(_Input):
    assignee_id: UUID | None = None
    start_on: date | None = None
    due_on: date | None = None
    label_ids: list[UUID] = Field(default_factory=list, max_length=20)
    position: int | None = Field(default=None, ge=0)

    @field_validator("label_ids")
    @classmethod
    def distinct_ids(cls, value: list[UUID]) -> list[UUID]:
        return _unique(value)

    @model_validator(mode="after")
    def dates_in_order(self) -> Self:
        _ordered(self.start_on, self.due_on)
        return self


class ObjectiveCreate(_CardValues):
    kind: Literal["objective"]
    stage_id: UUID
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)


class RecordCardCreate(_CardValues):
    kind: Literal["record"]
    stage_id: UUID
    record_id: UUID


CardCreate = Annotated[ObjectiveCreate | RecordCardCreate, Field(discriminator="kind")]


class CardPatch(_Input):
    """Fields, a move (stage and position) and dates in one revisioned change."""

    revision: Revision
    stage_id: UUID | None = None
    position: int | None = Field(default=None, ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    assignee_id: UUID | None = None
    start_on: date | None = None
    due_on: date | None = None
    label_ids: list[UUID] | None = Field(default=None, max_length=20)

    @field_validator("label_ids")
    @classmethod
    def distinct_labels(cls, value: list[UUID] | None) -> list[UUID] | None:
        return None if value is None else _unique(value)

    @model_validator(mode="after")
    def required_values(self) -> Self:
        _no_null(self, "stage_id", "position", "title", "label_ids")
        return self


class CardRestore(_Input):
    revision: Revision
    stage_id: UUID | None = None


class CardDates(_Input):
    card_id: UUID
    revision: Revision
    start_on: date | None
    due_on: date | None

    @model_validator(mode="after")
    def dates_in_order(self) -> Self:
        _ordered(self.start_on, self.due_on)
        return self


class CardBatchDates(_Input):
    items: list[CardDates] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def distinct_cards(self) -> Self:
        _unique([item.card_id for item in self.items])
        return self


class CardDatesUpdated(BaseModel):
    status: Literal["updated"] = "updated"
    card_id: UUID
    revision: int
    start_on: date | None
    due_on: date | None


class CardDatesStale(BaseModel):
    status: Literal["stale"] = "stale"
    card_id: UUID


class CardDatesForbidden(BaseModel):
    status: Literal["forbidden"] = "forbidden"
    card_id: UUID


CardDatesResult = Annotated[
    CardDatesUpdated | CardDatesStale | CardDatesForbidden, Field(discriminator="status")
]


class CardBatchDatesResponse(BaseModel):
    results: list[CardDatesResult]


class CardSort(StrEnum):
    RANK = "rank"
    DUE_ON = "due_on"
    START_ON = "start_on"
    CREATED_AT = "created_at"


class CardListRequest(StandardListRequest[CardSort]):
    stage_id: UUID | None = None
    assignee: UUID | Literal["me"] | None = None
    label: list[UUID] = Field(default_factory=list, max_length=20)
    due_from: date | None = None
    due_to: date | None = None
    archived: bool = False

    @model_validator(mode="after")
    def due_range(self) -> Self:
        if self.due_from is not None and self.due_to is not None and self.due_from > self.due_to:
            raise ValueError("due_from must not be after due_to")
        return self


class CardRecordField(BaseModel):
    field_id: UUID
    name: str
    value: str


class RecordSummary(BaseModel):
    """What a reader of the Record sees on the card, computed for this viewer now."""

    locked: Literal[False] = False
    record_id: UUID
    module_id: UUID
    module_name: str
    title: str
    fields: list[CardRecordField]
    status: CardRecordField | None


class LockedRecord(BaseModel):
    """A Record the viewer cannot read, or one in the trash: nothing about it."""

    locked: Literal[True] = True


class ChecklistProgress(BaseModel):
    done: int
    total: int


class CardResponse(BaseModel):
    id: UUID
    board_id: UUID
    stage_id: UUID
    kind: Literal["objective", "record"]
    title: str | None
    rank: int
    assignee_id: UUID | None
    start_on: date | None
    due_on: date | None
    label_ids: list[UUID]
    checklist: ChecklistProgress
    archived_at: datetime | None
    revision: int
    created_at: datetime
    updated_at: datetime
    record: RecordSummary | LockedRecord | None


class CardListResponse(StandardListResponse[CardResponse]):
    pass


class ChecklistItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    card_id: UUID
    text: str
    done: bool
    position: int
    revision: int


class CardDetail(CardResponse):
    description: str | None
    checklist_items: list[ChecklistItemResponse]


# Checklist


class ChecklistCreate(_Input):
    text: str = Field(min_length=1, max_length=200)


class ChecklistPatch(_Input):
    revision: Revision
    text: str | None = Field(default=None, min_length=1, max_length=200)
    done: bool | None = None

    @model_validator(mode="after")
    def required_values(self) -> Self:
        _no_null(self, "text", "done")
        return self


class ChecklistOrder(_Input):
    item_ids: list[UUID] = Field(min_length=1, max_length=50)

    @field_validator("item_ids")
    @classmethod
    def distinct_ids(cls, value: list[UUID]) -> list[UUID]:
        return _unique(value)


class ChecklistItems(BaseModel):
    items: list[ChecklistItemResponse]


# Card activity


class CardActivityKind(StrEnum):
    CARD = "card"
    LABEL = "label"
    CHECKLIST = "checklist"


class CardActivitySort(StrEnum):
    CREATED_AT = "created_at"


class CardActivityListRequest(StandardListRequest[CardActivitySort]):
    sort_order: SortOrder = SortOrder.DESC


class CardActivityResponse(BaseModel):
    id: UUID
    created_at: datetime
    kind: CardActivityKind
    action: AuditAction
    summary: str
    actor_label: str | None


class CardActivityListResponse(StandardListResponse[CardActivityResponse]):
    pass
