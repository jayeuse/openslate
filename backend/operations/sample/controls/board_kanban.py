"""The Kanban, card sheet and calendar routes on the temporary control Board.

The Board manager adds two stages, two labels, an objective card and a record card,
a checklist, a linked record, a file and two calendar sources (201); moves, labels,
ticks, attaches, dates, archives and restores (200), then removes what it added
(204). The administrator purges the detached file (200) so that the Board purge,
which refuses unpurged files, deletes everything else. Each response is validated
against the API's response model and each step reads its end state back.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, ValidationError

from app.systems.boards.attachment_router import AttachmentList
from app.systems.boards.calendar_source_router import CalendarSourceList
from app.systems.boards.kanban_schemas import CardDetail
from app.systems.boards.record_link_router import RecordLinkList
from operations.sample.actors import planned_access_level
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
)
from operations.sample.population.board_files import readback_files

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset

KANBAN_ROUTES = frozenset(
    {
        ("GET", "/api/boards/occurrences"),
        ("GET", "/api/boards/cards/due"),
        ("GET", "/api/boards/{board_id}/stages"),
        ("POST", "/api/boards/{board_id}/stages"),
        ("PATCH", "/api/boards/{board_id}/stages/{stage_id}"),
        ("PUT", "/api/boards/{board_id}/stages/order"),
        ("POST", "/api/boards/{board_id}/stages/{stage_id}/archive"),
        ("GET", "/api/boards/{board_id}/labels"),
        ("POST", "/api/boards/{board_id}/labels"),
        ("PATCH", "/api/boards/{board_id}/labels/{label_id}"),
        ("DELETE", "/api/boards/{board_id}/labels/{label_id}"),
        ("GET", "/api/boards/{board_id}/cards"),
        ("POST", "/api/boards/{board_id}/cards"),
        ("POST", "/api/boards/{board_id}/cards/batch-dates"),
        ("GET", "/api/boards/{board_id}/cards/{card_id}"),
        ("PATCH", "/api/boards/{board_id}/cards/{card_id}"),
        ("POST", "/api/boards/{board_id}/cards/{card_id}/archive"),
        ("POST", "/api/boards/{board_id}/cards/{card_id}/restore"),
        ("GET", "/api/boards/{board_id}/cards/{card_id}/activity"),
        ("POST", "/api/boards/{board_id}/cards/{card_id}/checklist"),
        ("PUT", "/api/boards/{board_id}/cards/{card_id}/checklist/order"),
        ("PATCH", "/api/boards/{board_id}/checklist/{item_id}"),
        ("DELETE", "/api/boards/{board_id}/checklist/{item_id}"),
        ("GET", "/api/boards/{board_id}/cards/{card_id}/attachments"),
        ("POST", "/api/boards/{board_id}/cards/{card_id}/attachments"),
        ("DELETE", "/api/boards/{board_id}/cards/{card_id}/attachments/{file_id}"),
        ("GET", "/api/boards/{board_id}/cards/{card_id}/attachments/{file_id}/content"),
        ("GET", "/api/boards/{board_id}/cards/{card_id}/record-links"),
        ("POST", "/api/boards/{board_id}/cards/{card_id}/record-links"),
        ("DELETE", "/api/boards/{board_id}/cards/{card_id}/record-links/{link_id}"),
        ("GET", "/api/boards/{board_id}/calendar-sources"),
        ("POST", "/api/boards/{board_id}/calendar-sources"),
        ("DELETE", "/api/boards/{board_id}/calendar-sources/{source_id}"),
        ("GET", "/api/me/calendar-sources"),
        ("POST", "/api/me/calendar-sources"),
        ("DELETE", "/api/me/calendar-sources/{source_id}"),
    }
)
KANBAN_OPERATIONS = {
    "kanban_create": 201,
    "kanban_update": 200,
    "kanban_remove": 204,
    "kanban_file_purge": 200,
}
_DATE_TYPES = {"Date", "Date/Time"}


def _date_source(dataset: SampleDataset, actor_key: str, department: str) -> tuple[str, str]:
    """The first module of the department, read by the actor, with a date field."""
    pack = dataset.organization
    for module in pack.catalog.modules:
        field = next((item for item in module.fields if item.type in _DATE_TYPES), None)
        if (
            module.department == department
            and field is not None
            and planned_access_level(pack, actor_key, department, module.key) >= 1
        ):
            return module.key, f"{module.key}:{field.key}"
    raise ValueError("Kanban controls require a readable module with a date field")


def plan_kanban_controls(
    dataset: SampleDataset, *, manager: str, record_key: str, event_day: date
) -> tuple[PhaseAction, ...]:
    """Four ordered actions on ``control:board``; one write status per action."""
    pack = dataset.organization
    if pack.phases is None or pack.content.data.kanban is None:
        raise ValueError("Kanban controls require the pack's demo Kanban text")
    spec = pack.content.data.kanban
    objective = next(card for card in spec.cards if card.title is not None)
    checklist = [text for card in spec.cards for text in card.checklist][:2]
    module_key, field_key = _date_source(dataset, manager, pack.phases.existing_project_board[1])
    start = dataset.anchor_date
    values: dict[str, PhaseJsonValue] = {
        "board_key": "control:board",
        "event_key": "control:event",
        "record_key": record_key,
        "module_key": module_key,
        "field_key": field_key,
        "stages": [[name, color] for name, color in spec.stages[:2]],
        "labels": [[name, color] for name, color in spec.labels[:2]],
        "title": objective.title,
        "description": objective.description,
        "checklist": list(checklist),
        "filename": readback_files(pack)[0].filename,
        "due_on": event_day.isoformat(),
        "start_on": (start + timedelta(days=7)).isoformat(),
        "batch_due_on": (start + timedelta(days=21)).isoformat(),
        "window_start": start.isoformat(),
        "window_end": (start + timedelta(days=41)).isoformat(),
    }
    if len(checklist) != 2 or len(spec.stages) < 2 or len(spec.labels) < 2:
        raise ValueError("Kanban controls require two stages, labels and checklist items")
    return tuple(
        PhaseAction(
            key=f"control:board:{operation.replace('_', '-')}",
            phase="reorganization",
            kind="board_controls",
            actor_key="admin" if operation == "kanban_file_purge" else manager,
            target_key="control:kanban",
            values={"operation": operation, **values},
            expected_status=status,
            expected_detail=None,
            expected_end_state={"completed": True},
        )
        for operation, status in KANBAN_OPERATIONS.items()
    )


class _Kanban:
    def __init__(
        self, action: PhaseAction, context: PhaseExecutionContext, on_substep: PhaseSubstep | None
    ) -> None:
        self.action, self.context, self.on_substep = action, context, on_substep
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []
        self.values = action.values
        self.board_id = self.mapped("control_boards", self.text("board_key"))
        self.base = f"/api/boards/{self.board_id}"

    def text(self, key: str) -> str:
        value = self.values.get(key)
        if not isinstance(value, str) or not value:
            raise SamplePhaseActionError("Planned Kanban control is invalid", step=self.action.key)
        return value

    def pairs(self, key: str) -> list[tuple[str, Any]]:
        rows = self.values.get(key)
        pairs = [row for row in rows if isinstance(row, list)] if isinstance(rows, list) else []
        valid = isinstance(rows, list) and len(pairs) == len(rows)
        if not valid or any(len(row) != 2 for row in pairs):
            raise SamplePhaseActionError("Planned Kanban control is invalid", step=self.action.key)
        return [(str(name), color) for name, color in pairs]

    def mapped(self, kind: str, key: str) -> str:
        return _mapped_id(self.context, kind, key, step=self.action.key)

    def own(self, name: str) -> str:
        return self.mapped("control_kanban", name)

    def keep(self, name: str, server_id: object) -> str:
        client = _client(self.context, self.action.actor_key, step="record_kanban_mapping")
        _record_mapping(self.context, client, "control_kanban", name, str(server_id),
                        self.mappings)  # fmt: skip
        return self.own(name)

    def check(self, condition: bool, step: str) -> None:
        if not condition:
            raise SamplePhaseActionError("Kanban response differs from its plan", step=step)

    def call(
        self, method: str, path: str, step: str, model: type[BaseModel] | None, **kwargs: Any
    ) -> Any:
        expected = 200 if method == "GET" else self.action.expected_status
        response = _request(self.action, self.context, self.evidence,
                            actor_key=self.action.actor_key, method=method, path=path,
                            step=step, expected=expected, on_substep=self.on_substep,
                            **kwargs)  # fmt: skip
        if model is None:
            return response
        body = _read_json(response, step=step, request_id=_request_id(response))
        try:
            return model.model_validate(body)
        except ValidationError:
            raise SamplePhaseActionError("Kanban response shape differs", step=step) from None

    def read(self, path: str, step: str, model: type[BaseModel], **params: Any) -> Any:
        return self.call("GET", path, step, model, params=params or None)

    def card(self, name: str) -> CardDetail:
        detail: CardDetail = self.read(f"{self.base}/cards/{self.own(name)}", f"read_{name}",
                                       CardDetail)  # fmt: skip
        return detail

    def board_revision(self) -> int:
        body = _read_json(
            self.call("GET", self.base, "read_board_revision", None), step="read_board_revision"
        )
        revision = body.get("revision")
        if type(revision) is not int:
            raise SamplePhaseActionError("Board revision could not be read", step="read_board")
        return revision

    def content_revisions(self) -> dict[str, int]:
        return {
            "board_revision": self.board_revision(),
            "content_revision": self.card("card:objective").revision,
        }

    def sources(self, step: str) -> tuple[set[str], set[str]]:
        board = self.read(f"{self.base}/calendar-sources", f"{step}_board", CalendarSourceList)
        mine = self.read("/api/me/calendar-sources", f"{step}_mine", CalendarSourceList)
        return {str(row.id) for row in board.items}, {str(row.id) for row in mine.items}

    def listed(self, kind: str, step: str) -> set[str]:
        model = AttachmentList if kind == "attachments" else RecordLinkList
        page = self.read(f"{self.base}/cards/{self.own('card:objective')}/{kind}", step, model,
                         limit=20, offset=0)  # fmt: skip
        return {str(row.id) for row in page.items}

