"""Independent future Sandbox HTTP state machine; audits come from its mutations."""

import copy
import hashlib
import json
from uuid import NAMESPACE_URL, uuid5

import httpx

ADMIN_ID = "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8"
RUN_ID = "4e2f9a7c" * 4
DOCUMENT_ID = "76697e42-5d48-48a5-8ca6-c378e1cf9880"


def tree_copy(value):
    """Copy JSON-shaped state like copy.deepcopy, without its memo; other types use deepcopy."""
    if isinstance(value, dict):
        return {key: tree_copy(item) for key, item in value.items()}
    if isinstance(value, list):
        return [tree_copy(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return copy.deepcopy(value)


def identifier(value):
    return str(uuid5(NAMESPACE_URL, "version-prune-wire:" + value))


class VersionPruneWire:
    def __init__(self, dataset):
        self.dataset = dataset
        self.document = tree_copy(dataset.document)
        self.revision = 1
        self.versions, self.audit, self.requests = [], [], []
        self.phase, self.fault = "prepare", "none"
        self.prune_calls, self.delete_calls = 0, []
        self.document_reads = 0
        self.workspace = {"revision": 1}

    def hash(self):
        return hashlib.sha256(
            json.dumps(self.document, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def document_response(self):
        # httpx serializes the body when the response is built, so no copy is needed.
        return {
            "document": self.document,
            "revision": self.revision,
            "contentHash": self.hash(),
            "byteCount": len(json.dumps(self.document).encode()),
            "issues": [],
        }

    def active(self):
        return [row for row in self.versions if not row["isDeleted"]]

    def audit_row(self, request, request_id, entity_type, entity_id, action, before, after):
        self.audit.append(
            {
                "id": identifier("audit:" + str(len(self.audit))),
                "created_at": "2026-10-09T00:00:00Z",
                "performed_by": ADMIN_ID,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "action": action,
                "before": tree_copy(before),
                "after": tree_copy(after),
                "request_id": request_id,
                "request_method": request.method,
                "request_path": request.url.path,
                "target_label": "Owned version fixture",
                "department_id": None,
                "actor_label": "Fixture administrator",
                "actor_name": None,
                "note": None,
            }
        )

    def advance(self, request, request_id):
        previous = self.revision
        self.revision += 1
        self.audit_row(
            request,
            request_id,
            "sandbox_documents",
            DOCUMENT_ID,
            "update",
            {"revision": previous},
            {"revision": self.revision},
        )

    def create(self, request, request_id, body, kind="checkpoint"):
        sequence = len(self.versions) + 1
        row = {
            "id": identifier("version:" + str(sequence)),
            "sequence": sequence,
            "kind": kind,
            "label": body.get("label", "Published initial organization"),
            "note": body.get("note"),
            "sourceDocumentRevision": self.revision,
            "sourceVersionId": None,
            "contentHash": self.hash(),
            "byteCount": len(json.dumps(self.document).encode()),
            "metadataRevision": 1,
            "createdAt": "2026-10-09T00:00:00Z",
            "performedBy": ADMIN_ID,
            "isDeleted": False,
            "deletedAt": None,
            "document": tree_copy(self.document),
        }
        self.versions.append(row)
        self.audit_row(
            request,
            request_id,
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
        if kind != "published":
            self.advance(request, request_id)
        return row

    def delete(self, request, request_id, row):
        before = {"is_deleted": row["isDeleted"], "deleted_at": row["deletedAt"]}
        row.update(isDeleted=True, deletedAt="2026-10-09T00:00:00Z", performedBy=ADMIN_ID)
        self.audit_row(
            request,
            request_id,
            "sandbox_versions",
            row["id"],
            "delete",
            before,
            {"is_deleted": True, "deleted_at": row["deletedAt"]},
        )

    def page(self, request):
        rows = sorted(self.active(), key=lambda row: row["sequence"], reverse=True)
        limit, offset = (
            int(request.url.params.get("limit", 25)),
            int(request.url.params.get("offset", 0)),
        )
        items = [
            {key: value for key, value in row.items() if key != "document"}
            for row in rows[offset : offset + limit]
        ]
        body = {
            "items": items,
            "limit": limit,
            "offset": offset,
            "count": len(items),
            "total": len(rows),
            "hasMore": offset + len(items) < len(rows),
            "mutableCount": sum(row["kind"] != "published" for row in rows),
            "versionCap": 50,
        }
        if self.fault == "underfilled_page":
            body["items"], body["count"] = [], 0
        elif self.fault == "duplicate_id" and len(items) > 1:
            items[1]["id"] = items[0]["id"]
        elif self.fault == "wrong_kind" and items:
            items[0]["kind"] = "unrecognized"
        elif self.fault == "coerced_count":
            body["count"] = str(body["count"])
        elif self.fault == "wrong_capacity":
            body["mutableCount"] += 1
        elif self.fault == "foreign_row" and self.phase == "published":
            items[-1]["id"] = identifier("foreign")
        elif self.fault == "missing_list_createdAt":
            for row in items:
                del row["createdAt"]
        return httpx.Response(200, json=body)

    def handle(self, request):
        self.requests.append(request)
        request_id = identifier("request:" + str(len(self.requests)))
        response = self.route(request, request_id)
        response.headers["X-Request-ID"] = request_id
        response.headers["Cache-Control"] = "no-store"
        if self.fault == "missing_request_id" and request.url.path.endswith("/prune"):
            del response.headers["X-Request-ID"]
        return response

    def route(self, request, request_id):
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else {}
        if path == "/api/auth/login":
            return httpx.Response(
                200,
                json={"authenticated": True},
                headers={
                    "Set-Cookie": "openslate_csrf=fixture; Path=/; SameSite=Lax",
                },
            )
        if path == "/api/auth/me":
            return httpx.Response(
                200,
                json={
                    "id": ADMIN_ID,
                    "email": "fixture@example.test",
                    "status": "active",
                    "role": "admin",
                },
            )
        if path == "/api/workspace":
            if method == "PATCH":
                self.workspace.update({**body, "revision": self.workspace["revision"] + 1})
            return httpx.Response(200, json=self.workspace)
        if path == "/api/sandbox/document":
            self.document_reads += 1
            if (
                self.fault == "precontrol_race"
                and self.phase == "published"
                and self.document_reads == 1
            ):
                self.revision += 1
            if (
                self.fault == "revision_race"
                and self.phase == "published"
                and self.document_reads == 2
            ):
                self.revision += 1
            if method == "PUT":
                if body["expectedRevision"] != self.revision:
                    return httpx.Response(409, json={"detail": {"code": "stale_revision"}})
                self.document = tree_copy(body["document"])
                self.advance(request, request_id)
            return httpx.Response(200, json=self.document_response())
        if path == "/api/sandbox/export":
            assert request.url.params.get("includeVersions") == "false"
            return httpx.Response(
                200,
                content=json.dumps(self.document, sort_keys=True).encode(),
                headers={"Content-Type": "application/json"},
            )
        if path == "/api/sandbox/versions" and method == "GET":
            return self.page(request)
        if path == "/api/sandbox/versions" and method == "POST":
            if body["expectedRevision"] != self.revision:
                return httpx.Response(409, json={"detail": {"code": "stale_revision"}})
            if sum(row["kind"] != "published" for row in self.active()) >= 50:
                return httpx.Response(409, json={"detail": {"code": "version_limit"}})
            return httpx.Response(201, json=self.create(request, request_id, body))
        if path == "/api/sandbox/publication-previews":
            return httpx.Response(
                200,
                json={
                    "blockers": [],
                    "previewToken": "fixture-preview",
                    "impactDigest": "fixture-digest",
                    "counts": {
                        "departments": len(self.dataset.department_ids),
                        "modules": len(self.dataset.module_ids),
                        "relationships": len(self.dataset.relationship_ids),
                        "triggers": len(self.dataset.trigger_ids),
                    },
                },
            )
        if path == "/api/sandbox/publications":
            assert body["expectedRevision"] == self.revision
            row = self.create(request, request_id, body, kind="published")
            self.phase, self.document_reads = "published", 0
            return httpx.Response(201, json={"version": row})
        if path == "/api/sandbox/tests":
            return httpx.Response(201, json={"id": identifier("test:" + str(len(self.requests)))})
        if path == "/api/sandbox/versions/prune":
            self.prune_calls += 1
            if self.fault == "stale_prune" or body["expectedRevision"] != self.revision:
                return httpx.Response(409, json={"detail": {"code": "stale_revision"}})
            candidates = sorted(
                [row for row in self.active() if row["kind"] != "published"],
                key=lambda row: row["sequence"],
            )
            selected = candidates[: max(0, len(candidates) - 40)]
            if self.fault == "wrong_deleted_rows":
                selected[-1] = candidates[-1]
            for row in selected:
                self.delete(request, request_id, row)
            if selected:
                self.advance(request, request_id)
            self.phase = "pruned"
            count = len(selected) - (self.fault == "wrong_deleted_count")
            return httpx.Response(200, json={"deletedCount": count})
        if path.startswith("/api/sandbox/versions/"):
            row = next((row for row in self.active() if row["id"] == path.rsplit("/", 1)[-1]), None)
            if row is None:
                return httpx.Response(404, json={"detail": {"code": "version_not_found"}})
            if method == "GET":
                body = tree_copy(row)
                if self.fault == "missing_detail_sourceDocumentRevision":
                    del body["sourceDocumentRevision"]
                return httpx.Response(200, json=body)
            if method == "DELETE":
                self.delete_calls.append(row["id"])
                if self.fault == "cleanup_failure":
                    return httpx.Response(503, json={"detail": "unavailable"})
                if body["expectedRevision"] != self.revision:
                    return httpx.Response(409, json={"detail": {"code": "stale_revision"}})
                if row["kind"] == "published" or len(self.active()) <= 1:
                    return httpx.Response(409, json={"detail": {"code": "version_immutable"}})
                self.delete(request, request_id, row)
                self.advance(request, request_id)
                return httpx.Response(204)
        if path == "/api/audit-logs":
            rows = tree_copy(
                [row for row in self.audit if row["request_id"] == request.url.params["request_id"]]
            )
            if self.fault == "audit_wrong_actor" and rows:
                rows[0]["performed_by"] = identifier("other-admin")
            elif self.fault == "audit_wrong_request" and rows:
                rows[0]["request_path"] = "/api/sandbox/other"
            elif self.fault == "audit_wrong_entity" and rows:
                rows[0]["entity_id"] = identifier("other-version")
            elif self.fault == "audit_missing":
                rows = rows[:-1]
            elif self.fault == "audit_duplicate" and rows:
                rows.append(tree_copy(rows[0]))
            for row in rows:
                if row["entity_type"] != "sandbox_documents":
                    continue
                before = row["before"]["revision"]
                if self.fault == "repeated_revision_pairs":
                    row["before"]["revision"], row["after"]["revision"] = 1, 2
                elif self.fault == "wrong_checkpoint_gap" and before == 52:
                    row["before"]["revision"], row["after"]["revision"] = 51, 52
                elif self.fault == "wrong_cleanup_revision" and before == 53:
                    row["before"]["revision"], row["after"]["revision"] = 54, 55
            limit, offset = (
                int(request.url.params.get("limit", 100)),
                int(request.url.params.get("offset", 0)),
            )
            items = rows[offset : offset + limit]
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "pagination": {
                        "limit": limit,
                        "offset": offset,
                        "count": len(items),
                        "total": len(rows),
                        "has_more": offset + len(items) < len(rows),
                    },
                },
            )
        raise AssertionError("Unexpected synthetic version-prune route: " + method + " " + path)
