"""Board attachment controls: planned from pack data, sent in the frontend's shape."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import date
from pathlib import Path

import httpx
import pytest
from sample_board_files import (
    ACTOR_ID,
    ADMIN_ID,
    BOARD_ID,
    EVENT_ID,
    FILE_IDS,
    POST_ID,
    FakeBoard,
    FinalReadbackBoard,
    _context,
)

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.board_files import (
    board_author,
    plan_board_file_controls,
    verify_board_file_controls,
)
from operations.sample.controls.boards import CONTROL_ROUTES, execute_board_control
from operations.sample.controls.request_verification import verify_request_evidence
from operations.sample.dummy_files import dummy_file, extension_of
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import SamplePhaseActionError
from operations.sample.population.boards import project_board_logical_id
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import SEEDER_ROUTES


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_file_controls_use_the_anchor_boards_seeded_post_event_and_author(pack_key: str) -> None:
    pack = get_pack(pack_key)
    dataset = build_dataset("small", 83, date(2026, 10, 5), organization=pack)

    actions = plan_board_file_controls(dataset)

    assert [(a.values["operation"], a.expected_status) for a in actions] == [
        ("board_file_reserve", 201),
        ("board_file_upload", 200),
        ("post_attachment_create", 200),
        ("post_attachment_delete", 204),
        ("event_attachment_create", 200),
        ("event_attachment_delete", 204),
        ("board_files_archive_purge", 200),
    ]
    name, department = pack.phases.existing_project_board
    board_key = project_board_logical_id(department, name)
    assert {a.values["board_key"] for a in actions} == {board_key}
    assert all(a.kind == "board_controls" for a in actions)
    post_key, event_key = actions[2].values["content_key"], actions[4].values["content_key"]
    assert actions[3].values["content_key"] == post_key
    assert actions[5].values["content_key"] == event_key
    post_index = int(post_key.rsplit(":", 1)[1]) - 1
    event_index = int(event_key.rsplit(":", 1)[1]) - 1
    assert post_key.startswith(f"{board_key}:post:")
    assert event_key.startswith(f"{board_key}:event:")
    assert pack.content.data.post_states[post_index // 2] == "draft"
    author = board_author(dataset, department, name, post_index)
    assert board_author(dataset, department, name, event_index + 1) == author
    assert {a.actor_key for a in actions[:-1]} == {author} and author != "admin"
    assert actions[-1].actor_key == "admin"
    # One file per owner: a file attached to the post can never move to the event.
    files = actions[0].values["files"]
    assert files == actions[1].values["files"] == actions[-1].values["files"]
    assert [row["file_key"] for row in files] == [
        actions[2].values["file_key"],
        actions[4].values["file_key"],
    ]
    names = [row["filename"] for row in files]
    pack_names = {item.filename for item in pack.content.data.board_files}
    assert set(names) <= pack_names and len({extension_of(n) for n in names}) == 2
    assert actions[2].values["filename"] == names[0]
    assert actions[4].values["filename"] == names[1]

    planned = plan_controls(dataset)
    assert [a.key for a in planned if a.key in {b.key for b in actions}] == [a.key for a in actions]
    assert CONTROL_ROUTES >= {
        ("PUT", "/api/boards/{board_id}/files/{file_id}/content"),
        ("GET", "/api/boards/{board_id}/events/{event_id}/attachments/{file_id}/content"),
    }
    assert CONTROL_ROUTES <= SEEDER_ROUTES


def test_file_controls_send_raw_bytes_and_the_attachment_panel_bodies(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("harbor"))
    actions = plan_board_file_controls(dataset)
    names = [row["filename"] for row in actions[0].values["files"]]
    fake = FakeBoard(names)
    context = _context(tmp_path, actions, fake)

    results = [execute_board_control(action, dataset, context) for action in actions]

    writes = [r for r in fake.seen if r.method != "GET"]
    assert [(r.method, r.url.path.removeprefix(f"/api/boards/{BOARD_ID}")) for r in writes] == [
        ("POST", "/files"),
        ("POST", "/files"),
        ("PUT", f"/files/{FILE_IDS[0]}/content"),
        ("PUT", f"/files/{FILE_IDS[1]}/content"),
        ("POST", f"/posts/{POST_ID}/attachments"),
        ("DELETE", f"/posts/{POST_ID}/attachments/{FILE_IDS[0]}"),
        ("POST", f"/events/{EVENT_ID}/attachments"),
        ("DELETE", f"/events/{EVENT_ID}/attachments/{FILE_IDS[1]}"),
        *(
            (method, f"/files/{identifier}{suffix}")
            for identifier in FILE_IDS
            for method, suffix in (
                ("POST", "/archive"),
                ("POST", "/purge/preview"),
                ("POST", "/purge"),
            )
        ),
    ]
    assert [json.loads(r.content) for r in writes[:2]] == [
        {"filename": name, "expected_size": len(dummy_file(name))} for name in names
    ]
    for request, name in zip(writes[2:4], names, strict=True):
        assert request.content == dummy_file(name)
        assert request.headers["Content-Type"] == "application/octet-stream"
    assert json.loads(writes[4].content) == {
        "file_id": FILE_IDS[0],
        "board_revision": 3,
        "content_revision": 5,
    }
    assert json.loads(writes[5].content) == {"board_revision": 4, "content_revision": 6}
    assert json.loads(writes[6].content) == {
        "file_id": FILE_IDS[1],
        "board_revision": 5,
        "content_revision": 7,
    }
    post_reads = [r for r in fake.seen if r.method == "GET" and f"/posts/{POST_ID}" in r.url.path]
    assert post_reads and all(r.url.params.get("view") == "draft" for r in post_reads)
    downloads = [
        r
        for r in fake.seen
        if r.url.path.endswith("/content") and "/attachments/" in r.url.path and r.method == "GET"
    ]
    assert len(downloads) == 2
    for result, action in zip(results, actions, strict=True):
        evidence = result["request_evidence"]
        assert evidence and all(
            item["actor_key"] == action.actor_key
            and item["actor_id"] == (ADMIN_ID if action.actor_key == "admin" else ACTOR_ID)
            and item["status_code"] == item["expected_status"] == action.expected_status
            for item in evidence
        )
    assert fake.linked == {POST_ID: set(), EVENT_ID: set()}
    # The run verifier accepts the evidence: unique steps, known routes, planned actor.
    issues: list[str] = []
    observed = {"control_requests_verified": 0}
    actors = {actions[0].actor_key: ACTOR_ID, "admin": ADMIN_ID}
    seen: set[str] = set()
    for action, result in zip(actions, results, strict=True):
        verify_request_evidence(
            dataset, {"actor_ids": actors}, action, result, actors, ADMIN_ID, seen, observed,
            issues,
        )  # fmt: skip
    assert issues == []
    assert observed["control_requests_verified"] == 14
    assert fake.purged == set(FILE_IDS)
    journal = (tmp_path / "board-file-requests.jsonl").read_text()
    assert "fixture-only" not in journal and "owned-file-preview" not in journal


def test_file_control_refuses_a_download_that_differs_from_the_upload(tmp_path: Path) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("school"))
    actions = plan_board_file_controls(dataset)
    names = [row["filename"] for row in actions[0].values["files"]]

    class SniffingBoard(FakeBoard):
        def __call__(self, request: httpx.Request) -> httpx.Response:
            response = super().__call__(request)
            if request.url.path.endswith("/content") and request.method == "GET":
                del response.headers["X-Content-Type-Options"]
            return response

    fake = SniffingBoard(names)
    context = _context(tmp_path, actions, fake)
    for action in actions[:2]:
        execute_board_control(action, dataset, context)

    with pytest.raises(SamplePhaseActionError, match="safe file download"):
        execute_board_control(actions[2], dataset, context)


@pytest.mark.parametrize("still_attached", (False, True))
def test_verifier_requires_control_files_detached_at_the_end(
    tmp_path: Path, still_attached: bool
) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("harbor"))
    actions = plan_board_file_controls(dataset)
    names = [row["filename"] for row in actions[0].values["files"]]
    fake = FakeBoard(names)
    fake.archived.update(FILE_IDS)
    fake.purged.update(FILE_IDS)
    if still_attached:
        fake.linked[EVENT_ID].add(FILE_IDS[1])
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "verify.jsonl",
        transport=httpx.MockTransport(fake),
    )
    mappings = {
        "boards": {actions[0].values["board_key"]: BOARD_ID},
        "posts": {actions[2].values["content_key"]: POST_ID},
        "events": {actions[4].values["content_key"]: EVENT_ID},
        "control_files": {"control:post-file": FILE_IDS[0], "control:event-file": FILE_IDS[1]},
    }

    issues = verify_board_file_controls(
        client, actions, mappings, actor_ids={actions[0].actor_key: ACTOR_ID}, admin_id=ADMIN_ID
    )

    assert issues == (
        ["A Board control file is still attached after its planned removal"]
        if still_attached
        else []
    )


@pytest.mark.parametrize(
    "fault, message",
    [
        ("wrong_board", "identity"),
        ("not_purged", "identity"),
        ("content_present", "HTTP 200"),
        ("unavailable", "HTTP 503"),
        ("expired", "preview"),
        ("naive_expiry", "preview"),
        ("wrong_preview", "preview"),
        ("wrong_name", "preview"),
        ("wrong_page_purpose", "page"),
        ("missing_page_field", "page"),
        ("nonadvancing_page", "pagination"),
    ],
)
def test_board_file_purge_fails_closed_for_wrong_target_or_unproven_completion(
    tmp_path: Path,
    fault: str,
    message: str,
) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("school"))
    planned = plan_board_file_controls(dataset)
    names = [row["filename"] for row in planned[0].values["files"]]
    fake = FakeBoard(names)
    context = _context(tmp_path, planned, fake)
    for action in planned[:6]:
        execute_board_control(action, dataset, context)
    action = replace(
        planned[-1],
        actor_key="admin",
        target_key="control:files",
        values={
            "operation": "board_files_archive_purge",
            "board_key": planned[0].values["board_key"],
            "files": planned[0].values["files"],
            "source_actor": planned[0].actor_key,
        },
        expected_status=200,
        expected_end_state={"files_purged": 2},
    )
    fake.fault = fault
    with pytest.raises(
        SampleClientError if fault == "unavailable" else SamplePhaseActionError, match=message
    ):
        execute_board_control(action, dataset, context)
    if fault in {
        "wrong_board",
        "unavailable",
        "expired",
        "naive_expiry",
        "wrong_preview",
        "wrong_name",
        "wrong_page_purpose",
        "missing_page_field",
        "nonadvancing_page",
    }:
        assert not fake.purged


def test_owned_board_file_purge_finds_only_its_two_ids_after_full_archived_pages(
    tmp_path: Path,
) -> None:
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("harbor"))
    actions = plan_board_file_controls(dataset)
    fake = FakeBoard([row["filename"] for row in actions[0].values["files"]])
    context = _context(tmp_path, actions, fake)
    for action in actions[:-1]:
        execute_board_control(action, dataset, context)
    fake.fault = "later_page"
    result = execute_board_control(actions[-1], dataset, context)
    assert result["files_purged"] == 2 and fake.purged == set(FILE_IDS)
    offsets = [
        r.url.params["offset"]
        for r in fake.seen
        if r.url.path == f"/api/boards/{BOARD_ID}/files" and r.method == "GET"
    ]
    assert offsets == ["0", "100", "0", "100"]
    assert [r.url.path.split("/")[5] for r in fake.seen if r.url.path.endswith("/purge")] == list(
        FILE_IDS
    )


def _completed_final_readback_run(tmp_path: Path, *, admin_creator: bool = False):
    dataset = build_dataset("small", 42, date(2026, 10, 5), organization=get_pack("harbor"))
    actions = plan_board_file_controls(dataset)
    if admin_creator:
        actions = tuple(replace(action, actor_key="admin") for action in actions[:-1]) + (
            replace(actions[-1], values={**actions[-1].values, "source_actor": "admin"}),
        )
    fake = FinalReadbackBoard(
        [row["filename"] for row in actions[0].values["files"]],
        creator_id=ADMIN_ID if admin_creator else ACTOR_ID,
    )
    context = _context(tmp_path, actions, fake)
    results = [execute_board_control(action, dataset, context) for action in actions]
    assert results[-1]["files_purged"] == 2 and fake.purged == set(FILE_IDS)
    assert fake.linked == {POST_ID: set(), EVENT_ID: set()}
    assert (
        verify_board_file_controls(
            context.clients["admin"],
            actions,
            context.runtime_mappings,
            actor_ids=context.user_ids,
            admin_id=ADMIN_ID,
        )
        == []
    )
    return actions, context, fake


@pytest.mark.parametrize(
    "fault",
    [
        "purpose",
        "missing_creator",
        "creator",
        "expected_size",
        "actual_size",
        "record_parent",
        "department_parent",
        "failure",
    ],
)
def test_final_board_file_metadata_refuses_contradictions_after_completed_api_journey(
    tmp_path: Path,
    fault: str,
) -> None:
    actions, context, fake = _completed_final_readback_run(tmp_path)
    fake.final_fault = fault
    issues = verify_board_file_controls(
        context.clients["admin"],
        actions,
        context.runtime_mappings,
        actor_ids=context.user_ids,
        admin_id=ADMIN_ID,
    )
    assert fake.altered_final_reads == 2
    assert issues, "Final verification accepted contradictory or incomplete fresh metadata"


@pytest.mark.parametrize("admin_creator", (False, True))
def test_final_board_file_metadata_accepts_complete_member_or_admin_identity(
    tmp_path: Path,
    admin_creator: bool,
) -> None:
    actions, context, fake = _completed_final_readback_run(tmp_path, admin_creator=admin_creator)
    assert (
        verify_board_file_controls(
            context.clients["admin"],
            actions,
            context.runtime_mappings,
            actor_ids=context.user_ids,
            admin_id=ADMIN_ID,
        )
        == []
    )
    assert fake.altered_final_reads == 0
