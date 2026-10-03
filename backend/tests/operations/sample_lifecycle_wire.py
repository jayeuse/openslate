"""Stateful lifecycle HTTP wire used by the existing Sandbox journey."""

from __future__ import annotations

import copy
import json
import re
from uuid import uuid4

import httpx

from app.systems.sandbox.departments.schemas import DepartmentResponse
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.service import canonical_document
from app.systems.sandbox.fields.schemas import FieldResponse
from app.systems.sandbox.modules.schemas import ModuleResponse
from tests.operations.test_sample_control_sandbox import ADMIN_ID


class _LifecycleWire:
    """Actual projected bindings, immutable publication and synchronized lifecycle."""

    def __init__(self, dataset, versions, initial_revision, fault):
        self.dataset, self.versions, self.initial_revision = dataset, versions, initial_revision
        self.fault, self.document, self.revision = fault, None, None
        self.live, self.identities, self.challenges = {}, {}, {}
        self.version_id, self.board_id = str(uuid4()), str(uuid4())
        self.board, self.final_mode = None, False

    def _bindings(self):
        rows = []
        for kind, items in (
            ("department", self.document["design"]["departments"]),
            ("module", self.document["design"]["modules"]),
            ("relationship", self.document["design"]["relationships"]),
            ("trigger", self.document["triggers"]),
        ):
            for item in items:
                rows.append(
                    {
                        "kind": kind,
                        "sandbox_id": item["id"],
                        "parent_sandbox_id": None,
                        "live_id": self.identities.get(item["id"], item["id"]),
                        "is_deleted": self.live.get(self.identities.get(item["id"]), {}).get(
                            "is_deleted", False
                        ),
                    }
                )
                if kind == "module":
                    for field in item["fields"]:
                        rows.append(
                            {
                                "kind": "field",
                                "sandbox_id": field["id"],
                                "parent_sandbox_id": item["id"],
                                "live_id": self.identities.get(field["id"], field["id"]),
                                "is_deleted": self.live.get(
                                    self.identities.get(field["id"]), {}
                                ).get("is_deleted", False),
                            }
                        )
        temporary = [row for row in rows if row["sandbox_id"] in self.identities]
        field = next((row for row in temporary if row["kind"] == "field"), None)
        if self.fault == "duplicate_binding" and temporary:
            rows.append(temporary[0])
        if self.fault == "internal_field_id" and field:
            field["sandbox_id"] = f"field:raw:36:{field['parent_sandbox_id']}:{field['sandbox_id']}"
        if self.fault == "wrong_parent" and field:
            field["parent_sandbox_id"] = self.document["design"]["modules"][0]["id"]
        if self.fault == "invalid_live_id" and field:
            field["live_id"] = "not-a-uuid"
        if self.fault == "missing_binding" and temporary:
            rows.remove(temporary[0])
        if self.fault == "alias_binding" and temporary:
            temporary[0]["live_id"] = rows[0]["live_id"]
        if self.final_mode and self.fault == "final_binding":
            sid, live_id = next(iter(self.identities.items()))
            rows.append(
                {
                    "kind": "department",
                    "sandbox_id": sid,
                    "parent_sandbox_id": None,
                    "live_id": live_id,
                    "is_deleted": True,
                }
            )
        rows.sort(key=lambda row: (row["kind"], row["parent_sandbox_id"] or "", row["sandbox_id"]))
        return {
            "document_revision": self.revision - (self.fault == "stale_bindings"),
            "items": rows,
        }

    def handle(self, request):
        method, path = request.method, request.url.path
        headers = {"X-Request-ID": str(uuid4())}
        if method == "PUT" and path == "/api/sandbox/document":
            body = json.loads(request.content)
            assert body["expectedRevision"] == self.initial_revision()
            self.document = body["document"]
            self.revision = body["expectedRevision"] + 1
        elif self.document is None:
            return None
        elif path == "/api/sandbox/publication-previews":
            assert json.loads(request.content) == {"expectedRevision": self.revision}
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "previewToken": "publication-fixture",
                    "impactDigest": "a" * 64,
                    "documentRevision": self.revision,
                    "documentHash": canonical_document(
                        SandboxDocument.model_validate(self.document)
                    )[1],
                    "expiresAt": "2099-01-01T00:00:00Z",
                    "changes": [
                        {
                            "kind": kind,
                            "action": "create",
                            "sandboxId": item["id"],
                            "label": item["name"],
                        }
                        for kind, item in (
                            ("department", self.document["design"]["departments"][-1]),
                            ("module", self.document["design"]["modules"][-1]),
                            *(
                                ("field", field)
                                for field in self.document["design"]["modules"][-1]["fields"]
                            ),
                        )
                    ],
                    "counts": {
                        "departments": 1,
                        "modules": 1,
                        "fields": 2,
                        "relationships": 0,
                        "triggers": 0,
                    },
                    "warnings": [],
                    "blockers": [],
                },
            )
        elif path == "/api/sandbox/publications":
            assert json.loads(request.content) == {
                "expectedRevision": self.revision,
                "previewToken": "publication-fixture",
                "impactDigest": "a" * 64,
                "password": "fixture-admin-password",
            }
            assert request.headers["Idempotency-Key"]
            if self.fault == "publication_503":
                return httpx.Response(
                    503,
                    headers=headers,
                    json={
                        "detail": {
                            "code": "publication_unavailable",
                            "message": "Unable to publish the Sandbox structure",
                        }
                    },
                )
            initial_departments = set(self.dataset.department_ids.values())
            department = next(
                item
                for item in self.document["design"]["departments"]
                if item["id"] not in initial_departments
            )
            module = next(
                item
                for item in self.document["design"]["modules"]
                if item["departmentId"] == department["id"]
            )
            for kind, item in (
                ("department", department),
                ("module", module),
                *(("field", field) for field in module["fields"]),
            ):
                live_id = str(uuid4())
                self.identities[item["id"]] = live_id
                self.live[live_id] = {
                    "id": live_id,
                    "kind": kind,
                    "sandbox_id": item["id"],
                    "name": item["name"],
                    "is_deleted": False,
                }
            self.live[self.identities[module["id"]]]["department_id"] = self.identities[
                department["id"]
            ]
            for field in module["fields"]:
                self.live[self.identities[field["id"]]]["module_id"] = self.identities[module["id"]]
                self.live[self.identities[field["id"]]]["type"] = (
                    "text" if field["type"] == "Text" else "long_text"
                )
                self.live[self.identities[field["id"]]]["position"] = module["fields"].index(field)
            self.live[self.identities[module["id"]]]["title_field_id"] = self.identities[
                module["titleFieldId"]
            ]
            self.board = {
                "id": self.board_id,
                "scope": "department",
                "department_id": self.identities[department["id"]],
                "name": department["name"],
                "description": None,
                "status": "active",
                "revision": 1,
                "level": "manage",
                "created_at": "2026-10-03T00:00:00Z",
                "updated_at": "2026-10-03T00:00:00Z",
            }
            snapshot, digest, byte_count = canonical_document(
                SandboxDocument.model_validate(self.document)
            )
            self.versions[self.version_id] = {
                "id": self.version_id,
                "sequence": 5,
                "kind": "published",
                "label": "Published structure",
                "document": snapshot,
                "contentHash": digest,
                "isDeleted": False,
                "note": None,
                "sourceDocumentRevision": self.revision,
                "sourceVersionId": None,
                "byteCount": byte_count,
                "metadataRevision": 1,
                "createdAt": "2026-10-03T00:00:00Z",
                "performedBy": ADMIN_ID,
                "deletedAt": None,
            }
            return httpx.Response(
                201,
                headers=headers,
                json={
                    "id": str(uuid4()),
                    "version": {
                        key: self.versions[self.version_id][key]
                        for key in ("id", "sequence", "kind", "label")
                    },
                    "documentRevision": self.revision,
                    "documentHash": digest,
                    "impactDigest": "a" * 64,
                    "publishedAt": "2026-10-03T00:00:00Z",
                },
            )
        elif path == "/api/sandbox/bindings":
            return httpx.Response(200, json=self._bindings())
        elif path == f"/api/sandbox/versions/{self.version_id}":
            body = copy.deepcopy(self.versions[self.version_id])
            if self.fault == "bad_snapshot" or (self.final_mode and self.fault == "final_snapshot"):
                body["document"] = self.dataset.document
            return httpx.Response(200, json=body)
        elif path == "/api/boards":
            assert dict(request.url.params) == {
                "scope": "department",
                "department_id": self.board["department_id"],
                "status": "all",
                "limit": "100",
                "offset": "0",
            }
            return httpx.Response(
                200,
                json={
                    "items": [self.board],
                    "pagination": {
                        "limit": 100,
                        "offset": 0,
                        "count": True if self.fault == "board_page_types" else 1,
                        "total": 1,
                        "has_more": False,
                    },
                },
            )
        elif path == f"/api/boards/{self.board_id}":
            if self.board is None or self.board.get("purged"):
                if not (self.final_mode and self.fault == "final_board"):
                    return httpx.Response(404, json={"detail": "Board not found"})
            return httpx.Response(200, json=self.board or {"id": self.board_id})
        elif re.fullmatch(r"/api/(departments|modules|fields)/[0-9a-f-]{36}(/.*)?", path):
            resource, live_id, *command = path.split("/")[2:]
            row = self.live.get(live_id)
            if not command:
                if row is None:
                    if self.final_mode and self.fault == "final_live":
                        return httpx.Response(200, json={"id": live_id, "is_deleted": True})
                    return httpx.Response(
                        404, json={"detail": resource[:-1].capitalize() + " not found"}
                    )
                wire = {
                    "id": live_id,
                    "is_deleted": row["is_deleted"],
                    "created_at": "2026-10-03T00:00:00Z",
                    "updated_at": "2026-10-03T00:00:00Z",
                    "deleted_at": "2026-10-03T00:00:00Z" if row["is_deleted"] else None,
                    "performed_by": ADMIN_ID,
                }
                if resource == "departments":
                    model = DepartmentResponse
                    wire["department_name"] = row["name"]
                elif resource == "modules":
                    model = ModuleResponse
                    wire.update(
                        module_name=row["name"],
                        department_id=row["department_id"],
                        title_field_id=row["title_field_id"],
                    )
                else:
                    model = FieldResponse
                    wire.update(
                        name=row["name"],
                        module_id=row["module_id"],
                        type=row["type"],
                        position=row["position"],
                        config={},
                        required=False,
                    )
                return httpx.Response(200, json=model.model_validate(wire).model_dump(mode="json"))
            assert row is not None and row["kind"] + "s" == resource
            operation = command[0]
            impact = {
                "target_type": row["kind"],
                "target_id": live_id,
                "operation": operation,
                "actor_id": ADMIN_ID,
                "rows": [
                    {
                        "entity_type": item["kind"] + "s",
                        "entity_id": item["id"],
                        "is_deleted": item["is_deleted"],
                        "deleted_at": "2026-10-03T00:00:00Z" if item["is_deleted"] else None,
                        "updated_at": "2026-10-03T00:00:00Z",
                        "state_fingerprint": "a" * 64,
                    }
                    for item in self.live.values()
                    if item["id"] == live_id or item.get("module_id") == live_id
                ],
                "external_impacts": [],
                "key_strips": [],
                "blockers": [],
                "impact_digest": "b" * 64,
            }
            if resource == "departments" and operation == "purge":
                impact["rows"].append(
                    {
                        "entity_type": "boards",
                        "entity_id": self.board_id,
                        "is_deleted": False,
                        "deleted_at": None,
                        "updated_at": "2026-10-03T00:00:00Z",
                        "state_fingerprint": "c" * 64,
                    }
                )
            if len(command) == 2:
                assert command[1] == "preview" and not request.content
                if operation == "purge" and self.fault == "purge_disabled":
                    return httpx.Response(
                        403,
                        headers=headers,
                        json={
                            "detail": {
                                "code": "purge_disabled",
                                "message": "Purge is not enabled pending retention approval",
                            }
                        },
                    )
                if self.fault == "wrong_preview_target":
                    impact["target_id"] = str(uuid4())
                if self.fault == "preview_blocker":
                    impact["blockers"] = [
                        {
                            "code": "title_field_selected",
                            "entity_type": resource,
                            "entity_id": live_id,
                            "detail": "Selected field is the module title",
                        }
                    ]
                token = str(uuid4())
                self.challenges[token] = (live_id, operation)
                return httpx.Response(
                    200,
                    headers=headers,
                    json={
                        "impact": impact,
                        "token": token,
                        "expires_at": "2099-01-01T00:00:00Z",
                        "confirmation_name": row["name"]
                        if self.fault != "empty_confirmation"
                        else "",
                    },
                )
            body = json.loads(request.content)
            if operation == "reopen":
                assert body == {"confirmed": True} and row["is_deleted"]
            else:
                assert set(body) == {"token", "confirmation_name", "password"}
                assert self.challenges.pop(body["token"]) == (live_id, operation)
                assert body["confirmation_name"] == row["name"]
                assert body["password"] == "fixture-admin-password"
                assert row["is_deleted"] is (operation == "purge")
            before = copy.deepcopy(self.document)
            sid = row["sandbox_id"]
            design = self.document["design"]
            if operation == "purge":
                if resource == "fields":
                    module = next(
                        item for item in design["modules"] if item["id"] in self.identities
                    )
                    module["fields"] = [field for field in module["fields"] if field["id"] != sid]
                else:
                    design[resource] = [item for item in design[resource] if item["id"] != sid]
                    design["layout"].pop(sid)
                removed = [
                    key
                    for key, item in self.live.items()
                    if key == live_id or item.get("module_id") == live_id
                ]
                for key in removed:
                    del self.live[key]
                if resource == "departments":
                    self.board["purged"] = True
                if self.fault == "purge_draft_remains":
                    self.document = before
            else:
                item = next(
                    item
                    for item in (
                        design[resource]
                        if resource != "fields"
                        else next(
                            module
                            for module in design["modules"]
                            if module["id"] in self.identities
                        )["fields"]
                    )
                    if item["id"] == sid
                )
                item["closed"] = operation == "close"
                for target in self.live.values():
                    if target["id"] == live_id or target.get("module_id") == live_id:
                        target["is_deleted"] = operation == "close"
                if resource == "departments":
                    self.board["status"] = "archived" if operation == "close" else "active"
                    self.board["revision"] += 1
                if self.fault == "no_document_sync":
                    self.document = before
                if self.fault == "live_unsynced":
                    row["is_deleted"] = False
            self.revision += 2 if self.fault == "wrong_revision" else 1
            if self.fault == "wrong_mutation_actor":
                impact["actor_id"] = str(uuid4())
            return httpx.Response(
                200,
                headers=headers,
                json={"impact": impact, "operation_id": headers["X-Request-ID"]},
            )
        elif path != "/api/sandbox/document":
            return None
        if self.final_mode and self.fault == "final_document_shape":
            return httpx.Response(200, json=[])
        _, digest, byte_count = canonical_document(SandboxDocument.model_validate(self.document))
        published = self.versions.get(self.version_id)
        if published is None:
            _, published_hash, _ = canonical_document(
                SandboxDocument.model_validate(self.dataset.document)
            )
            latest = {
                "id": self.versions["published"]["id"],
                "sequence": 2,
                "label": "Published",
                "createdAt": "2026-10-03T00:00:00Z",
            }
        else:
            published_hash = published["contentHash"]
            latest = {key: published[key] for key in ("id", "sequence", "label", "createdAt")}
        return httpx.Response(
            200,
            headers=headers,
            json={
                "document": self.document,
                "revision": self.revision,
                "contentHash": digest,
                "byteCount": byte_count,
                "issues": [],
                "latestPublishedVersion": latest,
                "publishedHash": published_hash,
                "hasUnpublishedChanges": digest != published_hash,
            },
        )
