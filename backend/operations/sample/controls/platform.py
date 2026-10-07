"""Bounded Platform sample controls through authenticated UI contracts."""

import csv
import io
import json
import re
from collections.abc import Mapping
from typing import Any, NoReturn, cast

import httpx

from app.systems.access.users.schemas import UserPreferencesResponse
from app.systems.sandbox.records.import_router import RecordImportResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.openview_mutations import _delete_record, _purge_control_record
from operations.sample.controls.platform_verification import search_page_contains_target
from operations.sample.controls.platform_verification import validate_platform_page as _page
from operations.sample.controls.sandbox import fixture_values
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _result,
)
from operations.sample.population.boards import project_board_logical_id

OPERATIONS = (
    "import_csv_rows",
    "search_workspace",
    "export_and_purge_csv_rows",
    "review_self_theme",
    "toggle_restore_self_theme",
)
RECORD_KEYS = ("opening_review", "completion_review")


def plan_platform_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    pack = dataset.organization
    if pack.phases is None:
        return ()
    values = fixture_values(dataset)
    person = next(item for item in pack.actors.people if item.status == "active")
    board_name, department = pack.phases.existing_project_board
    board = project_board_logical_id(department, board_name)
    content = pack.content.data
    index = next(
        i for i in range(content.posts_per_board) if content.post_states[i // 2] == "published"
    )
    facts: dict[str, Any] = {
        **values,
        "headers": [values["title_field_name"], values["field_name"]],
        "cells": [
            [f"{values['module_name']} {stage} review", note]
            for stage, note in (
                ("opening", f"{pack.identity.workspace_name}, opening checklist"),
                (
                    "completion",
                    f"{pack.identity.workspace_name} completion checklist\n{values['field_name']}",
                ),
            )
        ],
        "person_key": person.key,
        "board_key": board,
        "post_key": f"{board}:post:{index + 1:02d}",
        "event_key": f"{board}:event:01",
    }
    ends: tuple[dict[str, PhaseJsonValue], ...] = (
        {"records_imported": 2},
        {"search_kinds_verified": 4},
        {"records_exported": 2, "records_purged": 2},
        {"self_theme_read": True},
        {"theme_restored": True},
    )
    return tuple(
        PhaseAction(
            key=f"control:platform:{operation}",
            phase="reorganization",
            kind="platform_controls",
            actor_key="admin",
            target_key="platform_self" if "theme" in operation else "platform_csv",
            values={"operation": operation, **facts},
            expected_status=200,
            expected_detail=None,
            expected_end_state=end,
        )
        for operation, end in zip(OPERATIONS, ends, strict=True)
    )


EVIDENCE_KEYS = tuple(
    "step actor_key actor_id method path expected_status status_code request_id".split()
)
READ_CHECKS = dict(zip(OPERATIONS, (2, 9, 6, 1, 3), strict=True))


def _fail(message: str, step: str) -> NoReturn:
    raise SamplePhaseActionError(message, step=step)


class _Run:
    def __init__(
        self, action: PhaseAction, context: PhaseExecutionContext, substep: PhaseSubstep | None
    ):
        self.action, self.context, self.substep = action, context, substep
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []
        self.reads = 0
        self.search_pages: dict[str, int] = {}
        self.actor = _id(context.user_ids, "admin", label="actor", step=action.key)
        self.ids = context.runtime_mappings.get("sandbox_lifecycle", {})
        self.facts: Mapping[str, Any] = action.values

    def request(
        self,
        method: str,
        path: str,
        step: str,
        *,
        expected: int = 200,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        response = _request(
            self.action,
            self.context,
            self.evidence,
            actor_key="admin",
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=self.substep,
            json_body=body,
            params=params,
        )
        self.reads += method == "GET"
        if method == "GET":
            request_id = _request_id(response)
            if request_id is None:
                _fail("Platform read has no canonical request identity", step)
            row: dict[str, object] = {"step": step, "actor_key": "admin", "actor_id": self.actor}
            row.update(
                method=method,
                path=path,
                expected_status=expected,
                status_code=response.status_code,
                request_id=request_id,
            )
            self.evidence.append(row)
        return response

    def get(self, path: str, step: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return _read_json(self.request("GET", path, step, params=params), step=step)

    def query(self, step: str, keys: set[str]) -> None:
        body = _read_json(
            self.request("POST", "/api/records/query", step, body=self.definition()), step=step
        )
        rows = _page(body, 25, step)
        if (
            body["pagination"]["has_more"] is not False
            or {row.get("id") for row in rows} != keys
            or len(rows) != len(keys)
        ):
            _fail("Disposable import module has unexpected records", step)

    def definition(self) -> dict[str, Any]:
        ids = [
            _id(self.ids, key, label="fixture field", step=self.action.key)
            for key in ("title_field", "field")
        ]
        return {
            "module_id": _id(self.ids, "module", label="fixture module", step=self.action.key),
            "definition": {
                "version": 1,
                "columns": [
                    {"field_id": key, "expected_type": kind}
                    for key, kind in zip(ids, ("text", "long_text"), strict=True)
                ],
                "filters": [],
                "logic": "and",
                "sort": [],
                "deleted": "exclude",
                "search": None,
                "search_fields": [],
            },
        }

    def record(self, key: str, step: str, *, deleted: bool = False) -> dict[str, Any]:
        identifier = _mapped_id(self.context, "platform_records", key, step=step)
        row = self.get(f"/api/records/{identifier}", step)
        index = RECORD_KEYS.index(key)
        fields = (self.ids["title_field"], self.ids["field"])
        expected = dict(zip(fields, self.facts["cells"][index], strict=True))
        if (
            row.get("id") != identifier
            or row.get("module_id") != self.ids["module"]
            or row.get("data") != expected
            or row.get("is_deleted") is not deleted
        ):
            _fail("Imported record ownership or data differs", step)
        return row

    def theme(self, step: str, expected: str | None = None, *, write: bool = False) -> str:
        path = f"/api/users/{self.actor}/preferences"
        response = self.request(
            "PATCH" if write else "GET", path, step, body={"theme": expected} if write else None
        )
        try:
            preferences = UserPreferencesResponse.model_validate_json(response.content, strict=True)
        except ValueError:
            _fail("Self preferences response is invalid", step)
        if str(preferences.user_id) != self.actor or (
            expected is not None and preferences.theme != expected
        ):
            _fail("Self theme identity or confirmed value differs", step)
        appearance = preferences.appearance.model_dump(mode="json")
        if step == "read_original_theme":
            self.context.private_values["platform_original_appearance"] = appearance
        elif appearance != self.context.private_values.get("platform_original_appearance"):
            _fail("Self appearance settings changed during theme control", step)
        return preferences.theme

    def import_rows(self) -> None:
        fields = [self.ids["title_field"], self.ids["field"]]
        rows = [
            {"row_number": index + 2, "cells": cells}
            for index, cells in enumerate(self.facts["cells"])
        ]
        request: dict[str, Any] = {
            "mode": "preview",
            "module_id": self.ids["module"],
            "headers": self.facts["headers"],
            "mapping": [{"column_index": i, "field_id": field} for i, field in enumerate(fields)],
            "rows": rows,
            "defaults": {},
            "schema_digest": None,
        }
        self.query("before_import", set())
        receipts = None
        for mode, step in (("preview", "preview_import"), ("import", "commit_import")):
            request["mode"] = mode
            if (
                len(rows) > 100
                or len(json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode())
                > 921600
            ):
                _fail("CSV request exceeds the UI batch budget", step)
            response = self.request("POST", "/api/records/import", step, body=request)
            body = _read_json(response, step=step)
            try:
                parsed = RecordImportResponse.model_validate(body)
            except ValueError:
                _fail("Import receipt is malformed", step)
            if (
                parsed.mode != mode
                or re.fullmatch(r"[0-9a-f]{64}", parsed.schema_digest) is None
                or any(
                    type(body.get(key)) is not int
                    for key in ("valid_count", "invalid_count", "created_count")
                )
                or (parsed.valid_count, parsed.invalid_count, parsed.created_count)
                != (2, 0, 2 if mode == "import" else 0)
                or len(parsed.rows) != 2
                or (mode == "import" and parsed.schema_digest != request["schema_digest"])
            ):
                _fail("Import receipt counts or schema digest differ", step)
            identifiers = []
            for index, row in enumerate(parsed.rows):
                if (
                    row.row_number != index + 2
                    or row.status != ("created" if mode == "import" else "valid")
                    or row.errors
                    or row.data != dict(zip(fields, rows[index]["cells"], strict=True))
                    or (row.record_id is None) != (mode == "preview")
                ):
                    _fail("Import row receipt differs from submitted values", step)
                if row.record_id is not None:
                    identifiers.append(str(row.record_id))
            if len(set(identifiers)) != len(identifiers):
                _fail("Import record IDs are ambiguous", step)
            if mode == "preview":
                request["schema_digest"] = parsed.schema_digest
                self.query("after_preview", set())
            else:
                receipts = identifiers
        assert receipts is not None
        for key, identifier in zip(RECORD_KEYS, receipts, strict=True):
            _record_mapping(
                self.context,
                self.context.clients["admin"],
                "platform_records",
                key,
                identifier,
                self.mappings,
            )
        self.query("after_import", set(receipts))
        for key in RECORD_KEYS:
            self.record(key, f"read_import_{key}")

    def export_cleanup(self) -> None:
        response = self.request("POST", "/api/records/export", "export_csv", body=self.definition())
        if (
            response.headers.get("Content-Type", "").lower().replace(" ", "")
            != "text/csv;charset=utf-8"
            or response.headers.get("Content-Disposition") != 'attachment; filename="records.csv"'
            or "no-store" not in response.headers.get("Cache-Control", "").lower()
            or len(response.content) > 8 * 1024 * 1024
        ):
            _fail("Record CSV headers differ", "export_csv")
        try:
            cells = list(
                csv.reader(io.StringIO(response.content.decode("utf-8"), newline=""), strict=True)
            )
        except (csv.Error, UnicodeError):
            _fail("Record CSV is malformed", "export_csv")
        expected = {
            _mapped_id(self.context, "platform_records", key, step="export_csv"): self.facts[
                "cells"
            ][i]
            for i, key in enumerate(RECORD_KEYS)
        }
        if (
            not cells
            or cells[0] != ["Record ID", *self.facts["headers"]]
            or len(cells) != 3
            or any(len(row) != 3 for row in cells[1:])
            or {row[0]: row[1:] for row in cells[1:]} != expected
        ):
            _fail("Record CSV IDs, count or content differ", "export_csv")
        for key in RECORD_KEYS:
            self.record(key, f"before_delete_{key}")
        for key in RECORD_KEYS:
            identifier = _mapped_id(self.context, "platform_records", key, step="export_csv")
            _delete_record(
                self.action,
                self.context,
                self.evidence,
                actor_key="admin",
                record_id=identifier,
                step=f"delete_{key}",
                on_substep=self.substep,
            )
            self.record(key, f"deleted_{key}", deleted=True)
            _purge_control_record(
                self.action,
                self.context,
                self.evidence,
                record_id=identifier,
                preview_step=f"preview_purge_{key}",
                purge_step=f"purge_{key}",
                on_substep=self.substep,
            )
            self.request("GET", f"/api/records/{identifier}", f"purged_{key}", expected=404)

    def search(self) -> None:
        record = self.record(RECORD_KEYS[0], "search_record_oracle")
        person_id = _mapped_id(
            self.context, "user", cast(str, self.facts["person_key"]), step="search_person_oracle"
        )
        person = self.get(f"/api/users/{person_id}", "search_person_oracle")
        board_id = _mapped_id(
            self.context, "boards", cast(str, self.facts["board_key"]), step="search_board_oracle"
        )
        board = self.get(f"/api/boards/{board_id}", "search_board_oracle")
        post_id = _mapped_id(
            self.context, "posts", cast(str, self.facts["post_key"]), step="search_post_oracle"
        )
        event_id = _mapped_id(
            self.context, "events", cast(str, self.facts["event_key"]), step="search_event_oracle"
        )
        post = self.get(
            f"/api/boards/{board_id}/posts/{post_id}", "search_post_oracle", {"view": "published"}
        )
        event = self.get(f"/api/boards/{board_id}/events/{event_id}", "search_event_oracle")
        if (
            person.get("id") != person_id
            or board.get("id") != board_id
            or any(
                row.get("id") != identifier or row.get("board_id") != board_id
                for row, identifier in ((post, post_id), (event, event_id))
            )
        ):
            _fail("Search oracle identity differs", "search_oracles")
        oracles = {
            "record": (
                record["id"],
                record["data"][self.ids["title_field"]],
                self.facts["module_name"],
                self.ids["module"],
                None,
            ),
            "person": (
                person_id,
                person.get("display_name") or person.get("username"),
                person.get("username"),
                None,
                None,
            ),
            "post": (post_id, post.get("title"), board.get("name"), None, board_id),
            "event": (event_id, event.get("title"), board.get("name"), None, board_id),
        }
        for kind, oracle in oracles.items():
            step = f"search_{kind}"
            if not isinstance(oracle[1], str) or not oracle[1].strip():
                _fail("Search title is unavailable", step)
            total = None
            for index in range(100):
                offset = index * 10
                page_step = step if offset == 0 else f"{step}_page_{offset}"
                page = self.get(
                    "/api/search",
                    page_step,
                    {
                        "kind": kind,
                        "search": oracle[1][:100],
                        "limit": 10,
                        "offset": offset,
                        "sort_by": "relevance",
                        "sort_order": "desc",
                        "deleted": "exclude",
                    },
                )
                found = search_page_contains_target(
                    page, kind, oracle, offset=offset, step=page_step
                )
                current_total = page["pagination"]["total"]
                if total is not None and total != current_total:
                    _fail("Search total changed during traversal", page_step)
                total = current_total
                if found:
                    self.search_pages[kind] = index + 1
                    break
                if page["pagination"]["has_more"] is False:
                    _fail("Owned search result is absent or differs", page_step)
            else:
                _fail("Owned search result exceeds the 100-page bound", step)


def execute_platform_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_platform_controls(dataset):
        _fail("Platform control differs from its pack plan", action.key)
    run = _Run(action, context, on_substep)
    operation = action.values["operation"]
    extra: dict[str, object] = dict(action.expected_end_state)
    if operation == OPERATIONS[0]:
        run.import_rows()
    elif operation == OPERATIONS[1]:
        run.search()
        extra["search_pages"] = run.search_pages
    elif operation == OPERATIONS[2]:
        run.export_cleanup()
    elif operation == OPERATIONS[3]:
        original = run.theme("read_original_theme")
        context.private_values["platform_original_theme"] = original
        extra["original_theme"] = original
    else:
        original = cast(str, context.private_values.get("platform_original_theme"))
        if original not in ("light", "dark", "system"):
            _fail("Original self theme is unavailable", action.key)
        run.theme("theme_before_toggle", original)
        changed = "dark" if original == "light" else "light"
        run.theme("toggle_theme", changed, write=True)
        run.theme("theme_changed_readback", changed)
        run.theme("restore_theme", original, write=True)
        run.theme("theme_restore_readback", original)
        extra["original_theme"] = original
    if "original_theme" in extra:
        extra["original_appearance"] = context.private_values["platform_original_appearance"]
    extra["read_checks"] = run.reads
    evidence = [{key: row[key] for key in EVIDENCE_KEYS} for row in run.evidence]
    return _result(action, context, evidence, run.mappings, extra=extra)
