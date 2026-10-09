"""Shared HTTP state for real prune preparation and the retained lifecycle journey."""

from __future__ import annotations

import copy
import json
from collections.abc import MutableMapping
from uuid import uuid4

import httpx

from operations.sample.controls.sandbox import OPERATIONS
from operations.sample.population import workflow
from tests.operations.sample.controls.sample_lifecycle_wire import _LifecycleWire
from tests.operations.sample.controls.sample_version_prune_wire import (
    ADMIN_ID,
    RUN_ID,
    VersionPruneWire,
    identifier,
)


class _HistoryView(MutableMapping):
    """Keyed active rows are a view of the prune wire's retained version store."""

    def __init__(self, owner):
        self.owner, self.aliases = owner, {}

    def __getitem__(self, key):
        key = self.aliases.get(key, key)
        for row in self.owner.active():
            if row["id"] == key:
                return row
        raise KeyError(key)

    def __setitem__(self, key, value):
        assert key == value["id"] and key not in self
        row = copy.deepcopy(value)
        row["sequence"] = max((item["sequence"] for item in self.owner.versions), default=0) + 1
        self.owner.versions.append(row)

    def __delitem__(self, key):
        raise AssertionError("Version deletion must go through its authenticated HTTP command")

    def __iter__(self):
        return iter(row["id"] for row in self.owner.active())

    def __len__(self):
        return len(self.owner.active())


class _SharedLifecycleWire(_LifecycleWire):
    """Lifecycle uses the same draft/revision as preparation, prune and import."""

    def __init__(self, owner):
        self.owner, self.activated = owner, False
        super().__init__(owner.dataset, owner.history, lambda: owner.revision, "none")

    @property
    def document(self):
        return self.owner.document if self.activated else None

    @document.setter
    def document(self, value):
        self.activated = value is not None
        if self.activated:
            self.owner.document = value

    @property
    def revision(self):
        return self.owner.revision if self.activated else None

    @revision.setter
    def revision(self, value):
        if value is not None:
            self.owner.revision = value

    def handle(self, request):
        response = super().handle(request)
        if (
            response is not None
            and response.status_code == 200
            and request.url.path == "/api/sandbox/document"
        ):
            body = response.json()
            if isinstance(body, dict):
                published = max(
                    (row for row in self.owner.active() if row["kind"] == "published"),
                    key=lambda row: row["sequence"],
                )
                body["latestPublishedVersion"] = {
                    key: published[key] for key in ("id", "sequence", "label", "createdAt")
                }
                body["publishedHash"] = published["contentHash"]
                body["hasUnpublishedChanges"] = body["contentHash"] != published["contentHash"]
                return httpx.Response(200, headers=response.headers, json=body)
        return response


class SandboxControlWire(VersionPruneWire):
    """One stateful transport; each receipt/audit row follows its actual HTTP mutation."""

    def __init__(self, dataset, actions, fault):
        super().__init__(dataset)
        self.control_fault = fault
        self.actions = {action.values["operation"]: action for action in actions}
        self.history = _HistoryView(self)
        self.lifecycle = _SharedLifecycleWire(self)
        self.controls_started = False
        self.tests, self.created_test_ids = {}, []
        self.control_checkpoint_id, self.import_checkpoint_id = None, None
        self.history_mode, self.history_export_calls = False, 0
        self.history_export_state = None

    def prepare(self, context, journal_path):
        client = context.clients["admin"]
        fixture = workflow._publish_sandbox(
            client, self.dataset, context.admin_password, RUN_ID, ADMIN_ID
        )
        assert fixture is not None
        context.private_values["sandbox_prune_fixture"] = fixture
        context.runtime_mappings.update(workflow._journal_mappings(journal_path))
        self.history.aliases["published"] = context.runtime_mappings["sandbox_versions"][
            "published"
        ]
        self.controls_started = True

    def begin_action(self, action):
        if action.values["operation"] == "export_import_document":
            self.history_mode = True
        if action.values["operation"] in OPERATIONS:
            self.lifecycle.fault = self.control_fault

    def handle(self, request):
        self.requests.append(request)
        request_id = identifier("request:" + str(len(self.requests)))
        response = self.route(request, request_id)
        if "X-Request-ID" not in response.headers:
            response.headers["X-Request-ID"] = request_id
        response.headers["Cache-Control"] = "no-store"
        return response

    def _tests(self, request):
        path, method = request.url.path, request.method
        if path == "/api/sandbox/tests" and method == "POST":
            body = json.loads(request.content)
            vector = self.dataset.test_vectors[len(self.tests)]
            assert body == {
                "expectedRevision": self.revision,
                "moduleId": self.dataset.module_ids[vector.module_key],
                "values": vector.values,
                "event": vector.event,
                "triggerIds": list(vector.trigger_ids),
            }
            test_id = str(uuid4())
            if self.controls_started:
                self.created_test_ids.append(test_id)
            self.tests[test_id] = {
                "id": test_id,
                "input": {"moduleId": body["moduleId"], "values": body["values"]},
                "event": body["event"],
                "triggerIds": body["triggerIds"],
                "result": {"values": {}, "routes": [], "triggerTraces": [], "issues": []},
            }
            return httpx.Response(201, json=self.tests[test_id])
        if path == "/api/sandbox/tests" and method == "DELETE":
            assert self.tests
            self.tests.clear()
            return httpx.Response(204)
        if path == "/api/sandbox/tests" and method == "GET":
            assert dict(request.url.params) == {"limit": "100", "offset": "0"}
            items = list(self.tests.values())
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "limit": 100,
                    "offset": 0,
                    "count": len(items),
                    "total": len(items),
                    "hasMore": False,
                },
            )
        if path.startswith("/api/sandbox/tests/") and method == "GET":
            return httpx.Response(200, json=self.tests[path.rsplit("/", 1)[1]])
        return None

    def _history_export(self, request):
        flag = request.url.params.get("includeVersions")
        assert flag in {"true", "false"}
        if flag == "false":
            return None
        self.history_export_calls += 1
        self.history_export_state = (
            copy.deepcopy(self.document),
            self.revision,
            copy.deepcopy(self.versions),
        )
        body = copy.deepcopy(self.document)
        body["versions"] = [
            {
                "id": row["id"],
                "label": row["label"],
                "kind": row["kind"],
                "document": {
                    k: copy.deepcopy(v)
                    for k, v in row["document"].items()
                    if k not in {"kind", "schemaVersion"}
                },
                "published": row["kind"] == "published",
                "date": row["createdAt"],
                "note": row["note"],
            }
            for row in sorted(self.active(), key=lambda row: row["sequence"])
        ]
        fault = self.control_fault
        versions = body["versions"]
        if fault == "history_export_503":
            return httpx.Response(503, json={"detail": "Unavailable"})
        if fault == "history_export_missing":
            body.pop("versions")
        if fault == "history_export_null":
            body["versions"] = None
        if fault == "history_export_duplicate":
            versions.append(copy.deepcopy(versions[0]))
        if fault == "history_export_omitted":
            versions.pop()
        if fault == "history_export_foreign":
            versions[0]["id"] = str(uuid4())
        if fault == "history_export_order":
            versions.reverse()
        if fault == "history_export_label":
            versions[0]["label"] = "Different history label"
        if fault == "history_export_note":
            versions[0]["note"] = "Different history note"
        if fault == "history_export_published":
            versions[0]["published"] = not versions[0]["published"]
        if fault == "history_export_date":
            versions[0]["date"] = "2035-01-01T00:00:00Z"
        if fault == "history_export_invalid_date":
            versions[0]["date"] = "not-a-date"
        if fault == "history_export_snapshot":
            versions[0]["document"]["design"]["departments"][0]["name"] = "Different snapshot"
        if fault == "history_export_document":
            body["design"]["departments"][0]["name"] = "Different current document"
        if fault == "history_export_revision_race":
            self.revision += 1
        if fault == "history_export_history_race":
            self.active()[0].update(note="Concurrent note", metadataRevision=2)
        self.last_history_export = copy.deepcopy(body)
        return httpx.Response(200, json=body)

    def route(self, request, request_id):
        method, path = request.method, request.url.path
        tests = self._tests(request)
        if tests is not None:
            return tests
        if not self.controls_started:
            return super().route(request, request_id)
        if self.history_mode and path == "/api/sandbox/export" and method == "GET":
            exported = self._history_export(request)
            if exported is not None:
                return exported
        before_ids = {row["id"] for row in self.versions}
        lifecycle_response = self.lifecycle.handle(request)
        if lifecycle_response is not None:
            if (
                method == "POST"
                and path == "/api/sandbox/publications"
                and lifecycle_response.status_code == 201
            ):
                for row in self.versions:
                    if row["id"] not in before_ids:
                        self.audit_row(
                            request,
                            lifecycle_response.headers["X-Request-ID"],
                            "sandbox_versions",
                            row["id"],
                            "create",
                            None,
                            {
                                "kind": row["kind"],
                                "label": row["label"],
                                "content_hash": row["contentHash"],
                                "is_deleted": False,
                            },
                        )
            return lifecycle_response
        if path == "/api/sandbox/versions" and method == "POST":
            body = json.loads(request.content)
            action = self.actions["create_checkpoint"]
            assert body == {
                "expectedRevision": self.revision,
                "kind": "checkpoint",
                "label": action.values["label"],
                "note": action.values["note"],
            }
            row = self.create(request, request_id, body)
            self.control_checkpoint_id = row["id"]
            return httpx.Response(201, json=row)
        if path == f"/api/sandbox/versions/{self.control_checkpoint_id}" and method == "PATCH":
            body = json.loads(request.content)
            assert body == {
                "expectedRevision": self.revision,
                "label": self.actions["update_checkpoint"].values["label"],
            }
            row = self.history[self.control_checkpoint_id]
            before = {"label": row["label"], "metadata_revision": row["metadataRevision"]}
            row.update(label=body["label"], metadataRevision=row["metadataRevision"] + 1)
            self.audit_row(
                request,
                request_id,
                "sandbox_versions",
                row["id"],
                "update",
                before,
                {"label": row["label"], "metadata_revision": row["metadataRevision"]},
            )
            self.advance(request, request_id)
            return httpx.Response(200, json=row)
        if path == "/api/sandbox/imports" and method == "POST":
            body = json.loads(request.content)
            assert body == {"expectedRevision": self.revision, "bundle": self.document}
            row = self.create(request, request_id, {"label": "Before import", "note": None})
            self.import_checkpoint_id = row["id"]
            return httpx.Response(200, json=self.document_response())
        return super().route(request, request_id)
