"""Actual Platform wire composed with the accepted disposable lifecycle fixture."""

import copy
import json
from uuid import UUID, uuid4

import httpx

from app.systems.access.users.schemas import UserResponse
from app.systems.boards.event_schemas import EventResponse
from app.systems.boards.post_schemas import PostResponse
from app.systems.boards.schemas import BoardResponse
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.export import encode_csv
from app.systems.sandbox.records.import_router import RecordImportRequest
from app.systems.sandbox.records.importing import creation_schema_digest
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.query_schemas import RecordQuery
from tests.operations.sample_lifecycle_wire import _LifecycleWire
from tests.operations.test_sample_control_sandbox import ADMIN_ID, _login_response


class PlatformWire:
    def __init__(self, dataset, fault="none", original_theme="dark"):
        self.dataset, self.fault, self.theme = dataset, fault, original_theme
        self.original_theme = original_theme
        self.requests, self.records, self.created, self.tokens = [], {}, [], {}
        self.previews, self.commits, self.purges = 0, 0, 0
        self.pending_reviews = {}
        self.ids = {kind: str(uuid4()) for kind in ("person", "board", "post", "event")}
        self.search_decoys = [str(uuid4()) for _ in range(11)]
        versions = {
            key: {"id": str(uuid4()), "kind": kind}
            for key, kind in (("initial", "checkpoint"), ("published", "published"))
        }
        self.lifecycle = _LifecycleWire(dataset, versions, lambda: 12, "none")
        self.lifecycle.document, self.lifecycle.revision = copy.deepcopy(dataset.document), 12

    def bind(self, context):
        from operations.sample_control_platform import plan_platform_controls

        facts = plan_platform_controls(self.dataset)[0].values
        context.runtime_mappings.update(
            {
                "user": {facts["person_key"]: self.ids["person"]},
                "boards": {facts["board_key"]: self.ids["board"]},
                "posts": {facts["post_key"]: self.ids["post"]},
                "events": {facts["event_key"]: self.ids["event"]},
            }
        )

    def fields(self):
        rows = [row for row in self.lifecycle.live.values() if row.get("module_id")]
        return [
            Field(
                id=UUID(row["id"]),
                name=row["name"],
                type=kind,
                position=i,
                required=False,
                config={},
                is_deleted=False,
            )
            for i, (row, kind, config) in enumerate(
                zip(rows, ("text", "long_text"), ("text", "long-text"), strict=True)
            )
        ]

    def record(self, key):
        row = self.records[key]
        return {
            **row,
            "created_at": "2026-10-03T00:00:00Z",
            "updated_at": "2026-10-03T00:00:00Z",
            "deleted_at": "2026-10-03T00:00:00Z" if row["is_deleted"] else None,
            "performed_by": ADMIN_ID,
            "display_values": {},
        }

    def page(self, items, limit):
        return {
            "items": items,
            "pagination": {
                "limit": limit,
                "offset": 0,
                "count": len(items),
                "total": len(items),
                "has_more": False,
            },
        }

    def handle(self, request):
        self.requests.append(request)
        response = _login_response(request) or self.request(request)
        if response is None:
            raise AssertionError("Unexpected synthetic route")
        response.headers.setdefault("X-Request-ID", str(uuid4()))
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    def request(self, request):
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else None
        if path == "/api/records/import":
            parsed = RecordImportRequest.model_validate(body)
            assert parsed.module_id == UUID(
                next(row["id"] for row in self.lifecycle.live.values() if "department_id" in row)
            )
            fields = self.fields()
            assert parsed.headers == [field.name for field in fields]
            assert [(row.column_index, row.field_id) for row in parsed.mapping] == [
                (i, field.id) for i, field in enumerate(fields)
            ]
            assert parsed.defaults == {} and [row.row_number for row in parsed.rows] == [2, 3]
            assert len(request.content) <= 921600
            digest = creation_schema_digest(fields)
            if parsed.mode == "import":
                self.commits += 1
                assert self.previews == 1 and parsed.schema_digest == digest
                if self.fault == "import_503":
                    return httpx.Response(
                        503,
                        json={
                            "detail": {
                                "code": "record_import_unconfirmed",
                                "message": "Import outcome could not be confirmed",
                            }
                        },
                    )
            else:
                self.previews += 1
                assert parsed.schema_digest is None
            rows = []
            for row in parsed.rows:
                key = str(uuid4()) if parsed.mode == "import" else None
                data = {str(field.id): row.cells[i] for i, field in enumerate(fields)}
                if key:
                    self.records[key] = {
                        "id": key,
                        "module_id": str(parsed.module_id),
                        "data": data,
                        "is_deleted": False,
                    }
                    self.created.append(key)
                rows.append(
                    {
                        "row_number": row.row_number,
                        "status": "created" if key else "valid",
                        "record_id": key,
                        "data": data,
                        "errors": [],
                    }
                )
            result = {
                "mode": parsed.mode,
                "schema_digest": digest,
                "rows": rows,
                "valid_count": 2,
                "invalid_count": 0,
                "created_count": 2 if parsed.mode == "import" else 0,
            }
            if self.fault == "preview_created" and parsed.mode == "preview":
                result["created_count"] = 1
            if self.fault == "bad_digest" and parsed.mode == "preview":
                result["schema_digest"] = "wrong"
            if self.fault == "duplicate_ids" and parsed.mode == "import":
                rows[1]["record_id"] = rows[0]["record_id"]
            if self.fault == "wrong_row" and parsed.mode == "import":
                rows[0]["row_number"] = 4
            if self.fault == "wrong_data" and parsed.mode == "import":
                rows[0]["data"] = {}
            return httpx.Response(200, json=result)
        if path in ("/api/records/query", "/api/records/export"):
            parsed = RecordQuery.model_validate(body)
            fields = self.fields()
            assert list(body) == ["module_id", "definition"]
            assert [ref.field_id for ref in parsed.definition.columns] == [
                field.id for field in fields
            ]
            active = [
                self.record(key) for key, row in self.records.items() if not row["is_deleted"]
            ]
            if path.endswith("query"):
                return httpx.Response(200, json=self.page(active, 25))
            content, count = encode_csv(
                [Record(id=UUID(row["id"]), data=row["data"]) for row in active],
                fields,
                self.dataset.organization.identity.timezone,
                self.dataset.organization.identity.locale,
            )
            assert count == 2
            if self.fault == "csv_count":
                content += b"extra,wrong,wrong\r\n"
            if self.fault == "csv_content":
                content = content.replace(b"opening review", b"wrong review")
            return httpx.Response(
                200,
                content=content,
                headers={
                    "Content-Type": "application/json"
                    if self.fault == "csv_mime"
                    else "text/csv; charset=utf-8",
                    "Content-Disposition": 'attachment; filename="records.csv"',
                },
            )
        if path.startswith("/api/records/"):
            key = path.split("/")[3]
            row = self.records.get(key)
            if path.endswith("/purge/preview"):
                assert row and row["is_deleted"]
                n = self.pending_reviews.get(key, 0)
                self.pending_reviews[key] = n + 1
                blockers = (
                    [
                        {
                            "code": "purge_trigger_dependency",
                            "entity_type": "record_trigger_events",
                            "entity_id": key,
                            "message": "Record automation is pending",
                        }
                    ]
                    if n == 0
                    else []
                )
                if self.fault == "purge_blocker":
                    blockers = [{"code": "external_reference", "message": "Referenced record"}]
                token = str(uuid4())
                self.tokens[token] = key
                return httpx.Response(
                    200,
                    json={
                        "token": token,
                        "confirmation_name": key,
                        "expires_at": "2026-10-03T01:00:00Z",
                        "impact": {
                            "target_type": "record",
                            "target_id": key,
                            "operation": "purge",
                            "actor_id": ADMIN_ID,
                            "impact_digest": "a" * 64,
                            "rows": [],
                            "external_impacts": [],
                            "key_strips": [],
                            "blockers": blockers,
                        },
                    },
                )
            if path.endswith("/purge"):
                assert set(body) == {"token", "confirmation_name", "password"}
                assert self.tokens.pop(body["token"]) == body["confirmation_name"] == key
                assert body["password"] == "fixture-admin-password"
                self.purges += 1
                if self.fault != "purge_remains":
                    del self.records[key]
                request_id = str(uuid4())
                return httpx.Response(
                    200,
                    headers={"X-Request-ID": request_id},
                    json={
                        "operation_id": request_id,
                        "impact": {
                            "target_type": "record",
                            "target_id": key,
                            "operation": "purge",
                            "actor_id": ADMIN_ID,
                            "impact_digest": "a" * 64,
                            "rows": [],
                            "external_impacts": [],
                            "key_strips": [],
                            "blockers": [],
                        },
                    },
                )
            if method == "DELETE":
                assert row and not row["is_deleted"]
                row["is_deleted"] = True
                return httpx.Response(204)
            return (
                httpx.Response(200, json=self.record(key))
                if row
                else httpx.Response(404, json={"detail": "Record not found"})
            )
        if path.endswith("/preferences"):
            assert path == f"/api/users/{ADMIN_ID}/preferences"
            if method == "PATCH":
                assert set(body) == {"theme"} and body["theme"] in ("light", "dark")
                self.theme = body["theme"]
            value = self.theme
            if (
                self.fault == "theme_unsaved"
                and method == "GET"
                and self.theme != self.original_theme
            ):
                value = self.original_theme
            if (
                self.fault == "theme_restore"
                and method == "GET"
                and len([r for r in self.requests if r.method == "PATCH"]) == 2
            ):
                value = "light" if self.original_theme == "dark" else "dark"
            return httpx.Response(
                200,
                json={
                    "user_id": str(uuid4()) if self.fault == "theme_owner" else ADMIN_ID,
                    "theme": value,
                },
            )
        if path == "/api/search":
            query = dict(request.url.params)
            kind = query.pop("kind")
            text = query.pop("search")
            offset = int(query.pop("offset"))
            assert query == {
                "limit": "10",
                "sort_by": "relevance",
                "sort_order": "desc",
                "deleted": "exclude",
            }
            oracle = self.oracles()[kind]
            assert text == oracle["title"][:100]
            item = {"kind": kind, **oracle, "can_open": True}
            if self.fault == "search_kind":
                item["kind"] = "person" if kind == "record" else "record"
            if self.fault == "search_private":
                item["email"] = "synthetic@example.test"
            if self.fault == "search_context":
                item["context_label"] = "Different owner"
            items = [item]
            if kind == "event":
                items = [
                    dict(item, id=key, board_id=key, context_label="Other project")
                    for key in self.search_decoys
                ] + [item]
            page = self.page(items[offset : offset + 10], 10)
            page["pagination"].update(
                offset=offset, total=len(items), has_more=offset + len(page["items"]) < len(items)
            )
            if self.fault == "search_page":
                page["pagination"]["has_more"] = True
            return httpx.Response(200, json=page)
        if path == f"/api/users/{self.ids['person']}":
            person = next(
                p for p in self.dataset.organization.actors.people if p.status == "active"
            )
            return httpx.Response(
                200,
                json=UserResponse(
                    id=self.ids["person"],
                    email=f"{person.username}@example.test",
                    username=person.username,
                    display_name=person.name,
                    status="active",
                    role=person.role,
                    job_title=None,
                    sponsor_user_id=None,
                    expires_at=None,
                    invitation_sent_at=None,
                    deleted_at=None,
                    is_deleted=False,
                    performed_by=ADMIN_ID,
                    created_at="2026-10-03T00:00:00Z",
                    updated_at="2026-10-03T00:00:00Z",
                ).model_dump(mode="json"),
            )
        if path == f"/api/boards/{self.ids['board']}":
            return httpx.Response(
                200,
                json=BoardResponse(
                    id=self.ids["board"],
                    scope="project",
                    department_id=None,
                    name=self.dataset.organization.phases.existing_project_board[0],
                    description=None,
                    status="active",
                    revision=1,
                    level="manage",
                    created_at="2026-10-03T00:00:00Z",
                    updated_at="2026-10-03T00:00:00Z",
                ).model_dump(mode="json"),
            )
        for kind, resource in (("post", "posts"), ("event", "events")):
            if path == f"/api/boards/{self.ids['board']}/{resource}/{self.ids[kind]}":
                if kind == "post":
                    assert dict(request.url.params) == {"view": "published"}
                entity = dict(
                    id=self.ids[kind],
                    board_id=self.ids["board"],
                    author_id=ADMIN_ID,
                    title=self.oracles()[kind]["title"],
                    links=[],
                    board_revision=1,
                    created_at="2026-10-03T00:00:00Z",
                    updated_at="2026-10-03T00:00:00Z",
                )
                if kind == "post":
                    body = PostResponse(
                        **entity,
                        body="Opening checklist",
                        status="published",
                        publish_at=None,
                        expires_at=None,
                        pinned=False,
                        post_revision=1,
                        publication_number=1,
                        published_at="2026-10-03T00:00:00Z",
                        edited=False,
                    )
                else:
                    body = EventResponse(
                        **entity,
                        details="Review checklist",
                        location="Office",
                        all_day=True,
                        start_date="2026-10-03",
                        end_date="2026-10-03",
                        start_at=None,
                        end_at=None,
                        timezone_name=self.dataset.organization.identity.timezone,
                        recurrence="none",
                        repeat_until=None,
                        reminders=[],
                        archived=False,
                        revision=1,
                    )
                return httpx.Response(200, json=body.model_dump(mode="json"))
        return self.lifecycle.handle(request)

    def oracles(self):
        fields = self.fields()
        module = next(row for row in self.lifecycle.live.values() if "department_id" in row)
        person = next(p for p in self.dataset.organization.actors.people if p.status == "active")
        board = self.dataset.organization.phases.existing_project_board[0]
        spec = self.dataset.organization.content.data
        board_index = (
            1
            + len(self.dataset.organization.catalog.departments)
            + spec.projects.index(self.dataset.organization.phases.existing_project_board)
        )
        key = self.created[0]
        return {
            "record": {
                "id": key,
                "title": self.records[key]["data"][str(fields[0].id)],
                "context_label": module["name"],
                "module_id": module["id"],
                "board_id": None,
            },
            "person": {
                "id": self.ids["person"],
                "title": person.name,
                "context_label": person.username,
                "module_id": None,
                "board_id": None,
            },
            "post": {
                "id": self.ids["post"],
                "title": f"{board} opening checklist",
                "context_label": board,
                "module_id": None,
                "board_id": self.ids["board"],
            },
            "event": {
                "id": self.ids["event"],
                "title": spec.event_titles[board_index % len(spec.event_titles)],
                "context_label": board,
                "module_id": None,
                "board_id": self.ids["board"],
            },
        }
