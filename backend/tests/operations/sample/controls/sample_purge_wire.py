"""Stateful API boundary for disposable report and Board-event purge controls."""

from __future__ import annotations

import copy
import json
from typing import Any
from uuid import uuid4

import httpx

from app.systems.openview.reports.schemas import ReportCreate
from app.systems.sandbox.lifecycle.schemas import LifecyclePurgeRequest

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
BOARD_ID = "a36755cf-e6ed-4da7-bdee-d9154423b3fb"
EVENT_ID = "9748c02c-7e61-483e-ae88-6674e1bbcc4f"
REPORT_ID = "b3c81446-9795-4d91-a301-ea5f338f50cc"
TEMPORARY_REPORT_ID = "130fdb95-11a3-4b9c-807a-a2cb32985396"
MODULE_ID = "7193f7eb-4f53-4f9a-a928-59387341b871"
FIELD_ID = "123e0fcb-8826-497d-9553-d591481e3b28"
PASSWORD = "fixture-admin-password"
TOKEN = "private-purge-preview"
TIMESTAMP = "2026-10-01T00:00:00Z"


def response(status: int, body: object | None = None) -> httpx.Response:
    headers = {"X-Request-ID": str(uuid4())}
    return (
        httpx.Response(status, headers=headers)
        if status == 204
        else httpx.Response(status, headers=headers, json=body)
    )


def report_fixture(
    report_id: str = REPORT_ID,
    module_id: str = MODULE_ID,
    field_id: str = FIELD_ID,
    *,
    name: str = "Authored report",
) -> dict[str, Any]:
    return {
        "id": report_id,
        "module_id": module_id,
        "name": name,
        "subtitle": None,
        "revision": 7,
        "is_deleted": False,
        "recipe": {
            "version": 1,
            "fields": [{"field_id": field_id, "expected_type": "text"}],
            "filters": [],
            "logic": "and",
            "sorts": [],
            "group_by": None,
            "include_row_count": False,
        },
        "created_at": TIMESTAMP,
        "updated_at": TIMESTAMP,
    }


class SamplePurgeWire:
    """Mutates only fixture-owned targets through the same HTTP shapes as FastAPI."""

    def __init__(
        self,
        target_type: str,
        *,
        fault: str = "none",
        source: dict[str, Any] | None = None,
        actor_id: str = ADMIN_ID,
    ) -> None:
        self.target_type, self.fault, self.actor_id = target_type, fault, actor_id
        self.seen: list[httpx.Request] = []
        self.preview_attempts = self.purge_attempts = self.create_attempts = 0
        self.archive_attempts = 0
        self.purged = False
        self.board = {"id": BOARD_ID, "revision": 7, "status": "active"}
        self.event = {
            "id": EVENT_ID,
            "board_id": BOARD_ID,
            "title": "Archived  event / Résumé " + "長" * 160,
            "archived": fault != "active_event",
            "revision": 3,
            "board_revision": 7,
        }
        self.source = source if source is not None else report_fixture()
        self.original_source = copy.deepcopy(self.source)
        self.source_records = [{"id": MODULE_ID, "data": {FIELD_ID: "Authored record"}}]
        self.schedule = {"report_id": self.source["id"], "enabled": False}
        self.temporary: dict[str, Any] | None = None

    @property
    def target_id(self) -> str:
        return EVENT_ID if self.target_type == "board_event" else TEMPORARY_REPORT_ID

    @property
    def path(self) -> str:
        return (
            f"/api/boards/{BOARD_ID}/events/{EVENT_ID}"
            if self.target_type == "board_event"
            else f"/api/reports/{TEMPORARY_REPORT_ID}"
        )

    def impact(self) -> dict[str, Any]:
        return {
            "target_type": self.target_type,
            "target_id": self.target_id,
            "operation": "purge",
            "actor_id": self.actor_id,
            "rows": [],
            "external_impacts": [],
            "key_strips": [],
            "blockers": [],
            "impact_digest": "fixture-impact-digest",
        }

    def _preview(self) -> httpx.Response:
        self.preview_attempts += 1
        if self.fault == "preview_denied":
            return response(403, {"detail": "Private refusal canary"})
        if self.fault == "preview_unavailable":
            return response(503, {"detail": "Private dependency canary"})
        name = self.event["title"] if self.target_type == "board_event" else self.temporary["name"]
        body = {
            "impact": self.impact(),
            "token": TOKEN,
            "expires_at": "2030-10-01T00:00:00Z",
            "confirmation_name": name,
            "last_successful_backup_at": None,
        }
        if self.fault in {"preview_target", "preview_type", "preview_operation"}:
            key = self.fault.removeprefix("preview_")
            body["impact"][{"target": "target_id", "type": "target_type"}.get(key, key)] = {
                "target": REPORT_ID,
                "type": "record",
                "operation": "close",
            }[key]
        elif self.fault == "blockers":
            body["impact"]["blockers"] = [
                {
                    "code": "purge_report_dependency",
                    "entity_type": "reports",
                    "entity_id": REPORT_ID,
                    "detail": "A dependency remains",
                }
            ]
        elif self.fault == "missing_backup":
            del body["last_successful_backup_at"]
        elif self.fault in {"invalid_backup", "invalid_expiry"}:
            body[
                "last_successful_backup_at" if self.fault == "invalid_backup" else "expires_at"
            ] = "invalid"
        elif self.fault in {"empty_name", "malformed_name", "empty_token"}:
            body["token" if self.fault == "empty_token" else "confirmation_name"] = (
                42 if self.fault == "malformed_name" else ""
            )
        return response(200, body)

    def _purge(self, request: httpx.Request) -> httpx.Response:
        self.purge_attempts += 1
        payload = LifecyclePurgeRequest.model_validate(json.loads(request.content))
        expected_name = (
            self.event["title"] if self.target_type == "board_event" else self.temporary["name"]
        )
        assert payload.token == TOKEN and payload.password == PASSWORD
        assert payload.confirmation_name == expected_name
        if self.fault == "purge_denied":
            return response(403, {"detail": "Private refusal canary"})
        if self.fault == "purge_conflict":
            return response(409, {"detail": {"code": "purge_state_changed"}})
        if self.fault == "purge_unavailable":
            return response(503, {"detail": "Private dependency canary"})
        self.purged = self.fault != "retained_target"
        if self.target_type == "board_event" and self.fault != "unchanged_board_revision":
            self.board["revision"] += 1
        body = {"impact": self.impact(), "operation_id": str(uuid4())}
        if self.fault in {"result_target", "result_type", "result_operation"}:
            key = self.fault.removeprefix("result_")
            body["impact"][{"target": "target_id", "type": "target_type"}.get(key, key)] = {
                "target": REPORT_ID,
                "type": "record",
                "operation": "close",
            }[key]
        elif self.fault == "missing_operation_id":
            body["operation_id"] = None
        elif self.fault == "malformed_result":
            body["impact"] = None
        return response(200, body)

    def route(self, request: httpx.Request) -> httpx.Response | None:
        path, method = request.url.path, request.method
        if path == "/api/auth/login":
            actor = json.loads(request.content)["email"].partition("@")[0]
            return httpx.Response(
                200,
                headers=[
                    ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                    ("Set-Cookie", f"openslate_access={actor}; Path=/; HttpOnly"),
                ],
                json={"ok": True},
            )
        if self.target_type == "board_event":
            if path == f"/api/boards/{BOARD_ID}" and method == "GET":
                self.seen.append(request)
                return response(
                    404 if self.purged and self.fault == "removed_board" else 200, self.board
                )
            if path == self.path and method == "GET":
                self.seen.append(request)
                return response(404 if self.purged else 200, self.event)
        elif path == f"/api/reports/{self.source['id']}" and method == "GET":
            self.seen.append(request)
            if self.purged and self.fault == "changed_source":
                self.source["name"] = "Changed authored report"
            return response(200, self.source)
        elif path == "/api/reports" and method == "POST":
            self.seen.append(request)
            self.create_attempts += 1
            payload = ReportCreate.model_validate(json.loads(request.content))
            assert str(payload.module_id) == self.source["module_id"]
            assert payload.recipe.model_dump(mode="json") == self.source["recipe"]
            assert payload.name != self.source["name"]
            self.temporary = {
                **payload.model_dump(mode="json"),
                "id": self.source["id"] if self.fault == "created_source" else TEMPORARY_REPORT_ID,
                "revision": 1,
                "is_deleted": False,
                "created_at": TIMESTAMP,
                "updated_at": TIMESTAMP,
            }
            return response(201, self.temporary)
        elif path == self.path:
            self.seen.append(request)
            if method == "GET":
                return response(404 if self.purged else 200, self.temporary)
            if method == "DELETE":
                self.archive_attempts += 1
                assert self.temporary is not None
                assert int(request.url.params["revision"]) == self.temporary["revision"]
                self.temporary["is_deleted"] = True
                self.temporary["revision"] += 1
                return response(204)
        if path == self.path + "/purge/preview" and method == "POST":
            self.seen.append(request)
            assert not request.content
            return self._preview()
        if path == self.path + "/purge" and method == "POST":
            self.seen.append(request)
            return self._purge(request)
        return None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        result = self.route(request)
        assert result is not None, f"Unexpected request: {request.method} {request.url.path}"
        return result
