"""Board work as small steps by team members, run between record sessions.

Each post, event, record link and post life-cycle action is one step. Steps run in plan
order once their earlier steps and records exist; each write reads the current Board
and item revisions first, so people working on the same Board never use a stale one.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from operations.sample_board_entries import (
    _record_link,
    create_board_event,
    create_board_post,
    event_payload,
    finalize_post,
    validate_board_scenarios,
)
from operations.sample_board_text import post_text
from operations.sample_client import SampleClient
from operations.sample_content import _POST_STATES, SampleContentError, _id

_POSTS, _EVENTS = 8, 12
_SCENARIO_TOTAL, _SCENARIO_PAID = Decimal(12_000), Decimal(4_500)


@dataclass(frozen=True)
class BoardMeta:
    logical_id: str
    department_key: str | None
    scope: str
    authors: tuple[str, ...]  # people allowed to write on this Board, in rotation order


@dataclass(frozen=True)
class StepSpec:
    key: str
    kind: str  # post, event, link or lifecycle
    board: str
    index: int
    author_key: str
    needs_steps: tuple[str, ...] = ()
    needs_records: tuple[str, ...] = ()


def plan_board_steps(boards: Sequence[BoardMeta]) -> list[StepSpec]:
    """Interleave posts and events across Boards, then links, then post life cycles."""
    steps: list[StepSpec] = []
    for index in range(_EVENTS):
        for board_index, board in enumerate(boards):
            rotation = board_index * 3 + index
            if index < _POSTS:
                author = board.authors[rotation % len(board.authors)]
                steps.append(StepSpec(f"post:{board.logical_id}:{index}", "post",
                                      board.logical_id, index, author))  # fmt: skip
            author = board.authors[(rotation + 1) % len(board.authors)]
            steps.append(StepSpec(f"event:{board.logical_id}:{index}", "event",
                                  board.logical_id, index, author))  # fmt: skip
    by_key = {step.key: step for step in steps}
    finance = f"post:department:finance:{0}"
    field_event = f"event:department:field:{0}"
    if finance in by_key:
        steps.append(StepSpec("link:finance-post", "link", "department:finance", 0,
                              by_key[finance].author_key, (finance,),
                              ("invoices:000001", "payments:000001")))  # fmt: skip
    if field_event in by_key:
        steps.append(StepSpec("link:field-event", "link", "department:field", 0,
                              by_key[field_event].author_key, (field_event,),
                              ("equipment:000001", "work_orders:000001")))  # fmt: skip
    for index in range(_POSTS):
        if _POST_STATES[index // 2] == "draft":
            continue
        for board in boards:
            post = by_key[f"post:{board.logical_id}:{index}"]
            key = f"lifecycle:{board.logical_id}:{index}"
            steps.append(
                StepSpec(key, "lifecycle", board.logical_id, index, post.author_key, (post.key,))
            )
    return steps


@dataclass
class BoardQueue:
    """Runs planned Board steps a few at a time between record sessions."""

    steps: list[StepSpec]
    boards: Mapping[str, dict[str, Any]]  # Board specs by logical ID
    clients: Mapping[str, SampleClient]
    fields: Mapping[str, list[Mapping[str, Any]]]
    anchor_date: date
    every: int = 1
    counts: dict[str, int] = field(
        default_factory=lambda: dict.fromkeys(
            ("posts", "events", "reminders", "files", "record_links", "post_publications",
             "publication_revisions"), 0)
    )  # fmt: skip
    _done: set[str] = field(default_factory=set)
    _items: dict[str, dict[str, Any]] = field(default_factory=dict)
    _republished: set[str] = field(default_factory=set)

    def pace(self, sessions: int) -> None:
        self.every = max(1, sessions // max(1, len(self.steps)))

    def after_session(self, position: int, records: Mapping[str, Mapping[str, Any]]) -> None:
        if position % self.every == 0:
            self._run_next(records)

    def flush(self, records: Mapping[str, Mapping[str, Any]]) -> Mapping[str, int]:
        while len(self._done) < len(self.steps):
            if not self._run_next(records):
                raise SampleContentError("Board steps are waiting for records that do not exist")
        return self.counts

    def _run_next(self, records: Mapping[str, Mapping[str, Any]]) -> bool:
        for step in self.steps:
            if step.key in self._done:
                continue
            if all(need in self._done for need in step.needs_steps) and all(
                record in records for record in step.needs_records
            ):
                self._run(step, records)
                self._done.add(step.key)
                return True
        return False

    def _run(self, step: StepSpec, records: Mapping[str, Mapping[str, Any]]) -> None:
        board = self.boards[step.board]
        client = self.clients[step.author_key]
        board_index = list(self.boards).index(step.board)
        if step.kind == "post":
            title, body = post_text(board, step.index, _SCENARIO_TOTAL, _SCENARIO_PAID)
            saved = create_board_post(client, board["id"], title, body)
            client.record_mapping("posts", f"{step.board}:post:{step.index + 1:02d}", _id(saved))
            self._items[step.key] = {"id": _id(saved), "title": title, "body": body}
            self.counts["posts"] += 1
        elif step.kind == "event":
            payload, reminders = event_payload(board_index, step.index, self.anchor_date)
            saved = create_board_event(client, board["id"], payload)
            client.record_mapping("events", f"{step.board}:event:{step.index + 1:02d}", _id(saved))
            self._items[step.key] = {"id": _id(saved)}
            self.counts["events"] += 1
            self.counts["reminders"] += len(reminders)
        elif step.kind == "link":
            self._link(step, board, client, records)
        else:
            item = self._items[step.needs_steps[0]]
            post = {**item, "board": board, "writer": client, "index": step.index,
                    "board_index": board_index, "state": _POST_STATES[step.index // 2]}  # fmt: skip
            publications, revisions = finalize_post(post, self._republished, datetime.now(UTC))
            self.counts["post_publications"] += publications
            self.counts["publication_revisions"] += revisions

    def _link(
        self,
        step: StepSpec,
        board: Mapping[str, Any],
        client: SampleClient,
        records: Mapping[str, Mapping[str, Any]],
    ) -> None:
        record_ids = validate_board_scenarios(records, self.fields)["record_ids"]
        item_id = self._items[step.needs_steps[0]]["id"]
        is_post = step.key == "link:finance-post"
        for logical_id in step.needs_records:
            _record_link(client, "post" if is_post else "event", board["id"], item_id,
                         "post_revision" if is_post else "revision", str(record_ids[logical_id]),
                         logical_id, view="draft" if is_post else None)  # fmt: skip
            self.counts["record_links"] += 1
