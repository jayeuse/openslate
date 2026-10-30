"""Board work as small steps by team members, run between record sessions.

Each post, event, record link, attachment and post life-cycle action is one step. Steps run in plan
order once their earlier steps and records exist; each write reads the current Board
and item revisions first, so people working on the same Board never use a stale one.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from operations.sample.board_text import post_text
from operations.sample.client import SampleClient
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack
from operations.sample.population.board_entries import (
    _record_link,
    create_board_event,
    create_board_post,
    event_payload,
    finalize_post,
    validate_board_scenarios,
)
from operations.sample.population.board_files import attach_seeded_file
from operations.sample.population.content import SampleContentError, _id


@dataclass(frozen=True)
class BoardMeta:
    logical_id: str
    department_key: str | None
    scope: str
    authors: tuple[str, ...]  # people allowed to write on this Board, in rotation order


@dataclass(frozen=True)
class StepSpec:
    key: str
    kind: str  # post, event, link, file or lifecycle
    board: str
    index: int
    author_key: str
    needs_steps: tuple[str, ...] = ()
    needs_records: tuple[str, ...] = ()


# Posts and events per Board grow with the profile (spec R9).
PROFILE_SCALE = {"small": 1, "standard": 2, "large": 6}


def post_state(spec: Any, index: int) -> str:
    """The pack's authored life cycle for its own posts; later posts are mostly published."""
    if index < spec.posts_per_board:
        return str(spec.post_states[index // 2])
    return "archived" if index % 4 == 3 else "published"


def plan_board_steps(
    boards: Sequence[BoardMeta],
    *,
    organization: OrganizationPack | None = None,
    profile: str = "small",
) -> list[StepSpec]:
    """Interleave posts and events across Boards, then links and attachments, then post
    life cycles. Links and attachments edit the draft, so they run before the post's life cycle."""
    spec = (organization or default_pack()).content.data
    scale = PROFILE_SCALE[profile]
    posts, events = spec.posts_per_board * scale, spec.events_per_board * scale
    steps: list[StepSpec] = []
    for index in range(max(posts, events)):
        for board_index, board in enumerate(boards):
            rotation = board_index * 3 + index
            if index < posts:
                author = board.authors[rotation % len(board.authors)]
                steps.append(StepSpec(f"post:{board.logical_id}:{index}", "post",
                                      board.logical_id, index, author))  # fmt: skip
            if index < events:
                author = board.authors[(rotation + 1) % len(board.authors)]
                steps.append(StepSpec(f"event:{board.logical_id}:{index}", "event",
                                      board.logical_id, index, author))  # fmt: skip
    by_key = {step.key: step for step in steps}
    # Links and attachments both edit the draft, so a post's life cycle waits for them.
    drafts: dict[str, list[str]] = {}
    for link in spec.board_links:
        parent = f"{link.kind}:{link.board}:{link.index}"
        if parent in by_key:
            drafts.setdefault(parent, []).append(link.key)
            steps.append(
                StepSpec(
                    link.key,
                    "link",
                    link.board,
                    link.index,
                    by_key[parent].author_key,
                    (parent,),
                    link.records,
                )
            )
    for item in spec.board_files:
        parent = f"{item.kind}:{item.board}:{item.index}"
        if parent in by_key:
            steps.append(StepSpec(item.key, "file", item.board, item.index,
                                  by_key[parent].author_key, (parent,)))  # fmt: skip
            drafts.setdefault(parent, []).append(item.key)
    for index in range(posts):
        if post_state(spec, index) == "draft":
            continue
        for board in boards:
            post = by_key[f"post:{board.logical_id}:{index}"]
            key = f"lifecycle:{board.logical_id}:{index}"
            needs = (post.key, *drafts.get(post.key, ()))
            steps.append(
                StepSpec(key, "lifecycle", board.logical_id, index, post.author_key, needs)
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
    organization: OrganizationPack | None = None
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
        pack = self.organization or default_pack()
        spec = pack.content.data
        board = self.boards[step.board]
        client = self.clients[step.author_key]
        board_index = list(self.boards).index(step.board)
        if step.kind == "post":
            title, body = post_text(
                board, step.index, spec.scenario_total, spec.scenario_paid, organization=pack
            )
            saved = create_board_post(client, board["id"], title, body)
            client.record_mapping("posts", f"{step.board}:post:{step.index + 1:02d}", _id(saved))
            self._items[step.key] = {"id": _id(saved), "title": title, "body": body}
            self.counts["posts"] += 1
        elif step.kind == "event":
            payload, reminders = event_payload(
                board_index, step.index, self.anchor_date, organization=pack
            )
            saved = create_board_event(client, board["id"], payload)
            client.record_mapping("events", f"{step.board}:event:{step.index + 1:02d}", _id(saved))
            self._items[step.key] = {"id": _id(saved)}
            self.counts["events"] += 1
            self.counts["reminders"] += len(reminders)
        elif step.kind == "link":
            self._link(step, board, client, records)
        elif step.kind == "file":
            parent = step.needs_steps[0]
            filename = next(item.filename for item in spec.board_files if item.key == step.key)
            file_id = attach_seeded_file(client, board["id"], parent.partition(":")[0],
                                         self._items[parent]["id"], filename)  # fmt: skip
            client.record_mapping("files", step.key, file_id)
            self.counts["files"] += 1
        else:
            item = self._items[step.needs_steps[0]]
            post = {
                **item,
                "board": board,
                "writer": client,
                "index": step.index,
                "board_index": board_index,
                "state": post_state(spec, step.index),
            }
            publications, revisions = finalize_post(
                post, self._republished, datetime.now(UTC), organization=pack
            )
            self.counts["post_publications"] += publications
            self.counts["publication_revisions"] += revisions

    def _link(
        self,
        step: StepSpec,
        board: Mapping[str, Any],
        client: SampleClient,
        records: Mapping[str, Mapping[str, Any]],
    ) -> None:
        record_ids = validate_board_scenarios(
            records, self.fields, organization=self.organization, only=step.needs_records
        )["record_ids"]
        item_id = self._items[step.needs_steps[0]]["id"]
        is_post = step.needs_steps[0].startswith("post:")
        for logical_id in step.needs_records:
            _record_link(client, "post" if is_post else "event", board["id"], item_id,
                         "post_revision" if is_post else "revision", str(record_ids[logical_id]),
                         logical_id, view="draft" if is_post else None)  # fmt: skip
            self.counts["record_links"] += 1
