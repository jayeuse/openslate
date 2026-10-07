"""Generic sample file journeys consume real wire contracts and fail closed."""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from datetime import date
from io import BytesIO
from pathlib import Path
from urllib.parse import quote
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest
from PIL import Image

from app.systems.manage.workspace.schemas import WorkspaceUpdate
from app.systems.platform.files.schemas import FileCreate, FileResponse
from operations.sample.client import SampleClient, SampleWriteOutcomeUnknown
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.files import execute_file_control, plan_file_controls
from operations.sample.controls.files_verification import verify_file_controls, verify_file_evidence
from operations.sample.dummy_files import MEDIA_TYPES, dummy_file, extension_of
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset

OPERATIONS = ("generic_record_file", "generic_library_file", "workspace_logo_files")
ADMIN_ID = str(uuid5(NAMESPACE_URL, "sample-file-admin"))
ORIGINAL_THEME = "triplicate"
ORIGINAL_REVISION = 17
STAMP = "2026-10-07T00:00:00Z"


def _uuid(label: str) -> str:
    return str(uuid5(NAMESPACE_URL, label))


def _dataset(pack_key: str = "harbor"):
    return build_dataset("small", 83, date(2026, 10, 7), organization=get_pack(pack_key))


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_sample_plan_includes_generic_file_journeys_on_authored_parents(pack_key: str) -> None:
    dataset = _dataset(pack_key)
    actions = tuple(a for a in plan_controls(dataset) if a.values.get("operation") in OPERATIONS)
    assert tuple(a.values["operation"] for a in actions) == OPERATIONS, (
        "The authored control plan must include the three generic file journeys"
    )
    assert all(a.kind == "platform_controls" and a.actor_key == "admin" for a in actions)
    assert actions[0].values["record_key"] in {row.logical_id for row in dataset.records}
    assert actions[1].values["department_key"] in dataset.department_ids
    assert actions[2].expected_end_state["workspace_restored"] is True


class FileWire:
    """Owned HTTP state; reservations, image normalization and logo purge are real contracts."""

    def __init__(self, dataset, *, fault: str | None = None) -> None:
        self.dataset, self.fault = dataset, fault
        self.rows: dict[str, dict[str, object]] = {}
        self.bytes: dict[str, bytes] = {}
        self.seen: list[httpx.Request] = []
        self.counter = 0
        self.workspace = {
            "id": _uuid("workspace"),
            "display_name": "Sample organization",
            **dict.fromkeys(
                (
                    "legal_name description contact_email contact_phone postal_address logo_file_id"
                ).split()
            ),
            "timezone": "Asia/Manila",
            "locale": "en-PH",
            "mark": "SO",
            "currency": "PHP",
            "week_start": "monday",
            "business_hours": "09:00–17:00",
            "theme": ORIGINAL_THEME,
            "invitation_expiry_days": 7,
            "guest_duration_days": 30,
            "revision": ORIGINAL_REVISION,
            **dict.fromkeys(("created_at", "updated_at"), STAMP),
        }

    def response(self, status: int, body=None, *, content=None, headers=None):
        self.counter += 1
        wire_headers = {"X-Request-ID": _uuid(f"request:{self.counter}"), **(headers or {})}
        if content is not None:
            return httpx.Response(status, headers=wire_headers, content=content)
        return httpx.Response(status, headers=wire_headers, json=body)

    def file_response(self, row, *, mutate: bool = False):
        body = copy.deepcopy(row)
        if mutate:
            changes = {
                "identity": ("id", _uuid("wrong-file")),
                "filename": ("filename", "another-document.pdf"),
                "purpose": ("purpose", "library_document"),
                "record_parent": ("record_id", _uuid("wrong-record")),
                "department_parent": ("department_id", _uuid("wrong-department")),
                "creator": ("creator_id", _uuid("another-user")),
                "state": ("state", "uploading"),
                "expected_size": ("expected_size", int(row["expected_size"]) + 1),
                "actual_size": ("actual_size", int(row["actual_size"]) + 1),
                "media_type": ("media_type", "text/plain"),
                "deleted": ("is_deleted", True),
                "failure_code": ("failure_code", "upload_unresolved"),
            }
            if self.fault in changes:
                key, value = changes[self.fault]
                body[key] = value
        FileResponse.model_validate(body)
        return body

    def download(self, row, *, inline: bool = False):
        content = self.bytes[str(row["id"])]
        headers = {
            "Content-Type": str(row["media_type"]),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        if not inline:
            headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(
                str(row["filename"]), safe=""
            )
        if self.fault == "download_bytes":
            content = b"same metadata, different bytes"
        if self.fault == "download_disposition":
            headers["Content-Disposition"] = "inline"
        if self.fault == "download_sniff":
            del headers["X-Content-Type-Options"]
        if self.fault == "download_cache":
            headers["Cache-Control"] = "public"
        if self.fault == "logo_bytes" and inline:
            output = BytesIO()
            Image.new("RGBA", (1, 1), (0, 0, 0, 255)).save(output, format="PNG")
            content = output.getvalue()
        return self.response(200, content=content, headers=headers)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if path == "/api/auth/login":
            return self.response(
                200,
                {},
                headers={
                    "Set-Cookie": "openslate_csrf=fixture; Path=/",
                },
            )
        self.seen.append(request)
        if method != "GET":
            assert request.headers["X-CSRF-Token"] == "fixture"
        if path == "/api/workspace":
            if method == "PATCH":
                patch = WorkspaceUpdate.model_validate_json(request.content)
                assert patch.revision == self.workspace["revision"]
                old, new = self.workspace["logo_file_id"], patch.logo_file_id
                if new is not None:
                    assert str(new) in self.rows and self.rows[str(new)]["state"] == "ready"
                if old is not None and old != str(new) and self.fault != "logo_old_not_purged":
                    self.rows[str(old)].update(state="purged", is_deleted=True)
                self.workspace.update(patch.model_dump(mode="json", exclude_unset=True))
                self.workspace["revision"] += 1
                if new is None and self.fault == "restore_theme":
                    self.workspace["theme"] = "slate"
                if new is None and self.fault == "restore_binding":
                    self.workspace["logo_file_id"] = old
                if new is not None and self.fault == "logo_write_unknown":
                    return self.response(
                        503, {"detail": {"code": "workspace_logo_cleanup_partial"}}
                    )
            body = copy.deepcopy(self.workspace)
            if method == "GET" and body["logo_file_id"] and self.fault == "logo_readback":
                body["logo_file_id"] = _uuid("changed-logo-binding")
            return self.response(200, body)
        if path == "/api/workspace/logo":
            key = self.workspace["logo_file_id"]
            return self.download(self.rows[str(key)], inline=True) if key else self.response(404)
        if path.startswith("/api/records/"):
            key = path.rsplit("/", 1)[-1]
            record = next(r for r in self.dataset.records if _uuid(r.logical_id) == key)
            return self.response(
                200, {"id": key, "module_id": _uuid(record.module_key), "is_deleted": False}
            )
        if path.startswith("/api/departments/"):
            return self.response(200, {"id": path.rsplit("/", 1)[-1], "is_deleted": False})
        if path == "/api/files" and method == "POST":
            if self.fault == "authorization":
                return self.response(403, {"detail": "Forbidden"})
            payload = FileCreate.model_validate_json(request.content).model_dump(mode="json")
            key = _uuid(f"owned-file:{len(self.rows)}")
            self.rows[key] = {
                **payload,
                "id": key,
                "record_id": payload.get("record_id"),
                "department_id": payload.get("department_id"),
                "board_id": None,
                "creator_id": ADMIN_ID,
                "state": "awaiting_upload",
                "is_deleted": False,
                "actual_size": None,
                "media_type": None,
                "failure_code": None,
                "created_at": STAMP,
                "updated_at": STAMP,
            }
            return self.response(201, self.file_response(self.rows[key]))
        if path == "/api/files":
            params = request.url.params
            selected = [
                row
                for row in self.rows.values()
                if row["purpose"] == params["purpose"]
                and all(
                    params.get(k) == row[k]
                    for k in ("record_id", "department_id")
                    if params.get(k) is not None
                )
                and (
                    params.get("deleted") == "include"
                    or bool(row["is_deleted"]) == (params.get("deleted") == "only")
                )
            ]
            limit, offset = int(params.get("limit", "25")), int(params.get("offset", "0"))
            items = [self.file_response(row) for row in selected[offset : offset + limit]]
            page = {
                "limit": limit,
                "offset": offset,
                "count": len(items),
                "total": len(selected),
                "has_more": offset + len(items) < len(selected),
            }
            if self.fault == "pagination":
                page["count"] += 1
            body = {"items": items, "pagination": page}
            if params["purpose"] == "library_document":
                body.update(
                    creator_labels={ADMIN_ID: "Administrator"},
                    storage_used_bytes=sum(int(r["actual_size"] or 0) for r in selected),
                )
            return self.response(200, body)
        parts = path.removeprefix("/api/files/").split("/")
        if not parts or parts[0] not in self.rows:
            return self.response(404, {"detail": "File not found"})
        row = self.rows[parts[0]]
        command = parts[1] if len(parts) > 1 else None
        if command == "content" and method == "PUT":
            assert request.headers["Content-Type"] == "application/octet-stream"
            assert len(request.content) == row["expected_size"]
            content = request.content
            if row["purpose"] == "workspace_logo":
                output = BytesIO()
                with Image.open(BytesIO(content)) as image:
                    png = extension_of(str(row["filename"])) == ".png"
                    image.convert("RGBA" if png else "RGB").save(
                        output, format="PNG" if png else "JPEG"
                    )
                content = output.getvalue()
            self.bytes[str(row["id"])] = content
            row.update(
                state="ready",
                actual_size=len(content),
                media_type=MEDIA_TYPES[extension_of(str(row["filename"]))],
            )
            if self.fault == "write_unknown":
                return self.response(503, {"detail": {"code": "upload_unresolved"}})
            return self.response(200, self.file_response(row, mutate=True))
        if command == "content":
            return self.download(row) if row["state"] == "ready" else self.response(409)
        if command in {"archive", "reopen"}:
            row["is_deleted"] = command == "archive"
        if command == "reconcile":
            assert self.workspace["logo_file_id"] != row["id"]
        return self.response(200, self.file_response(row))


def _context(tmp_path: Path, dataset, wire: FileWire) -> PhaseExecutionContext:
    client = SampleClient(
        "http://sample.test",
        "http://localhost",
        tmp_path / "files.jsonl",
        transport=httpx.MockTransport(wire),
    )
    assert client.login("sample@example.test", "fixture-only").status_code == 200
    return PhaseExecutionContext(
        clients={"admin": client},
        user_ids={"admin": ADMIN_ID},
        group_ids={},
        field_ids={},
        department_ids={key: _uuid(key) for key in dataset.department_ids},
        module_ids={key: _uuid(key) for key in dataset.module_ids},
        mappings={
            "records": {row.logical_id: _uuid(row.logical_id) for row in dataset.records},
            "departments": {key: _uuid(key) for key in dataset.department_ids},
        },
        admin_password="fixture-only",
    )


def _run(tmp_path: Path, pack_key: str = "harbor", *, fault: str | None = None):
    dataset = _dataset(pack_key)
    actions = plan_file_controls(dataset)
    wire = FileWire(dataset, fault=fault)
    context = _context(tmp_path, dataset, wire)
    results = [execute_file_control(a, dataset, context) for a in actions]
    manifest = {
        "mappings": context.runtime_mappings,
        "control_results": results,
        "actor_ids": {"admin": ADMIN_ID},
    }
    return dataset, actions, wire, context, results, manifest


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_generic_files_use_ui_requests_and_restore_only_owned_logo_state(tmp_path, pack_key):
    dataset, actions, wire, context, results, manifest = _run(tmp_path, pack_key)
    reservations = [
        json.loads(r.content)
        for r in wire.seen
        if r.method == "POST" and r.url.path == "/api/files"
    ]
    assert [r["purpose"] for r in reservations] == [
        "record_attachment",
        "library_document",
        "workspace_logo",
        "workspace_logo",
    ]
    for row in reservations:
        assert row["expected_size"] == len(dummy_file(row["filename"]))
    uploads = [r for r in wire.seen if r.method == "PUT"]
    assert [r.content for r in uploads] == [dummy_file(row["filename"]) for row in reservations]
    assert all(r.headers["Content-Type"] == "application/octet-stream" for r in uploads)
    assert wire.workspace["theme"] == ORIGINAL_THEME and wire.workspace["logo_file_id"] is None
    assert wire.workspace["revision"] > ORIGINAL_REVISION
    assert [r["state"] for r in wire.rows.values() if r["purpose"] == "workspace_logo"] == [
        "purged",
        "purged",
    ]
    assert any(r.method == "POST" and r.url.path.endswith("/reconcile") for r in wire.seen)
    assert any(r.method == "GET" and r.url.path == "/api/workspace/logo" for r in wire.seen)
    counts, issues = verify_file_controls(
        context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
    )
    assert issues == []
    assert counts["record_files_archived"] == counts["library_files_reopened"] == 1
    assert counts["logos_purged"] == 2 and counts["workspace_restored"] == 1
    assert all(result["outcome"] == "completed" for result in results)


@pytest.mark.parametrize(
    "fault",
    (
        "identity",
        "filename",
        "purpose",
        "record_parent",
        "department_parent",
        "creator",
        "state",
        "deleted",
        "failure_code",
        "expected_size",
        "actual_size",
        "media_type",
        "pagination",
        "download_bytes",
        "download_disposition",
        "download_sniff",
        "download_cache",
        "logo_bytes",
        "logo_readback",
        "restore_theme",
        "restore_binding",
        "logo_old_not_purged",
    ),
)
def test_executor_refuses_unfaithful_file_or_logo_readback(tmp_path, fault):
    with pytest.raises(SamplePhaseActionError):
        _run(tmp_path, fault=fault)


def test_existing_human_logo_is_refused_before_any_logo_reservation(tmp_path):
    dataset = _dataset()
    action = plan_file_controls(dataset)[2]
    wire = FileWire(dataset)
    wire.workspace["logo_file_id"] = _uuid("human-logo")
    context = _context(tmp_path, dataset, wire)
    with pytest.raises(SamplePhaseActionError, match="logo"):
        execute_file_control(action, dataset, context)
    assert not any(r.method != "GET" for r in wire.seen)
    assert wire.workspace["logo_file_id"] == _uuid("human-logo")


def test_unplanned_actor_is_refused_before_file_requests(tmp_path):
    dataset = _dataset()
    action = replace(plan_file_controls(dataset)[0], actor_key="another-person")
    wire = FileWire(dataset)
    context = _context(tmp_path, dataset, wire)
    with pytest.raises(SamplePhaseActionError):
        execute_file_control(action, dataset, context)
    assert wire.seen == []


def test_server_authorization_denial_stops_before_upload(tmp_path):
    dataset = _dataset()
    action = plan_file_controls(dataset)[0]
    wire = FileWire(dataset, fault="authorization")
    context = _context(tmp_path, dataset, wire)
    with pytest.raises(SamplePhaseActionError) as rejected:
        execute_file_control(action, dataset, context)
    assert rejected.value.status_code == 403
    assert not wire.rows and not any(r.method == "PUT" for r in wire.seen)


def test_unknown_upload_outcome_stops_without_replay_or_followup_mutation(tmp_path):
    dataset = _dataset()
    action = plan_file_controls(dataset)[0]
    wire = FileWire(dataset, fault="write_unknown")
    context = _context(tmp_path, dataset, wire)
    with pytest.raises(SampleWriteOutcomeUnknown):
        execute_file_control(action, dataset, context)
    assert sum(r.method == "PUT" for r in wire.seen) == 1
    assert wire.seen[-1].method == "PUT"
    assert not any(r.url.path.endswith(("/archive", "/reopen", "/reconcile")) for r in wire.seen)


def test_unknown_logo_binding_stops_without_replay_or_compensating_overwrite(tmp_path):
    dataset = _dataset()
    action = plan_file_controls(dataset)[2]
    wire = FileWire(dataset, fault="logo_write_unknown")
    context = _context(tmp_path, dataset, wire)
    with pytest.raises(SampleWriteOutcomeUnknown):
        execute_file_control(action, dataset, context)
    patches = [r for r in wire.seen if r.method == "PATCH"]
    assert len(patches) == 1 and wire.seen[-1] is patches[0]
    assert wire.workspace["logo_file_id"] is not None


@pytest.mark.parametrize("fault", ("record_archive", "library_reopen", "logo_purge", "theme"))
def test_final_verifier_reads_state_instead_of_trusting_completed_results(tmp_path, fault):
    dataset, _actions_value, wire, context, _results, manifest = _run(tmp_path)
    if fault == "theme":
        wire.workspace["theme"] = "slate"
    for row in wire.rows.values():
        if fault == "record_archive" and row["purpose"] == "record_attachment":
            row["is_deleted"] = False
        if fault == "library_reopen" and row["purpose"] == "library_document":
            row["is_deleted"] = True
        if fault == "logo_purge" and row["purpose"] == "workspace_logo":
            row["state"] = "ready"
    _counts, issues = verify_file_controls(
        context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
    )
    assert issues


@pytest.mark.parametrize(
    "fault", ("actor", "status", "request_identity", "path", "method", "missing_step")
)
def test_file_request_verifier_rejects_evidence_unbound_to_successful_actor(tmp_path, fault):
    dataset, actions, _wire, _context_value, results, manifest = _run(tmp_path)
    result = copy.deepcopy(results[0])
    row = result["request_evidence"][0]
    if fault == "actor":
        row["actor_id"] = _uuid("wrong-actor")
    elif fault == "status":
        row["status_code"] = 503
    elif fault == "request_identity":
        row["request_id"] = None
    elif fault == "path":
        row["path"] = f"/api/records/{_uuid('unrelated-record')}"
    elif fault == "method":
        row["method"] = "DELETE"
    else:
        result["request_evidence"].pop(0)
    issues: list[str] = []
    verify_file_evidence(
        dataset,
        manifest,
        actions[0],
        result,
        ADMIN_ID,
        set(),
        {"control_requests_verified": 0},
        issues,
    )
    assert issues


def test_file_request_evidence_matches_the_complete_actual_journeys(tmp_path):
    dataset, actions, _wire, _context_value, results, manifest = _run(tmp_path)
    issues: list[str] = []
    observed = {"control_requests_verified": 0}
    seen: set[str] = set()
    for action, result in zip(actions, results, strict=True):
        verify_file_evidence(dataset, manifest, action, result, ADMIN_ID, seen, observed, issues)
    assert issues == []
    assert observed["control_requests_verified"] == sum(len(r["request_evidence"]) for r in results)
