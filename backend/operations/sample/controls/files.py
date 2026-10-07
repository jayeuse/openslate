"""Owned generic files and reversible Workspace logos through the normal UI APIs."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.files_verification import (
    check_download,
    file_metadata,
    file_page,
    workspace_profile,
)
from operations.sample.dummy_files import dummy_file
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

FILE_OPERATIONS = frozenset({"generic_record_file", "generic_library_file", "workspace_logo_files"})
FILE_CONTROL_ROUTES = frozenset(
    {
        ("POST", "/api/files"),
        ("GET", "/api/files"),
        ("GET", "/api/files/{file_id}"),
        ("PUT", "/api/files/{file_id}/content"),
        ("GET", "/api/files/{file_id}/content"),
        ("POST", "/api/files/{file_id}/archive"),
        ("POST", "/api/files/{file_id}/reopen"),
        ("POST", "/api/files/{file_id}/reconcile"),
        ("GET", "/api/workspace/logo"),
    }
)
FILE_KEYS = {
    key: f"control:generic-file:{key}"
    for key in ("record_attachment", "library_document", "logo_primary", "logo_replacement")
}
FILE_NAMES = {
    "record_attachment": "sample-record-attachment.pdf",
    "library_document": "sample-library-document.docx",
    "logo_primary": "sample-logo-primary.png",
    "logo_replacement": "sample-logo-replacement.jpg",
}
EVIDENCE_KEYS = tuple(
    "step actor_key actor_id method path expected_status status_code request_id".split()
)


def plan_file_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    record = dataset.records[0]
    if record.actor_key not in dataset.department_ids:
        raise ValueError("File controls need an authored record and department")
    choices: tuple[tuple[str, str, dict[str, PhaseJsonValue], dict[str, PhaseJsonValue]], ...] = (
        (
            "generic_record_file",
            record.logical_id,
            {
                "record_key": record.logical_id,
                "module_key": record.module_key,
                "purpose": "record_attachment",
            },
            {"record_files_archived": 1},
        ),
        (
            "generic_library_file",
            record.actor_key,
            {"department_key": record.actor_key, "purpose": "library_document"},
            {"library_files_reopened": 1},
        ),
        (
            "workspace_logo_files",
            "owned_workspace_logo",
            {},
            {"logos_purged": 2, "workspace_restored": True},
        ),
    )
    return tuple(
        PhaseAction(
            key=f"control:files:{operation}",
            phase="reorganization",
            kind="platform_controls",
            actor_key="admin",
            target_key=target,
            values={"operation": operation, **values},
            expected_status=200,
            expected_detail=None,
            expected_end_state=end,
        )
        for operation, target, values, end in choices
    )


class _Run:
    def __init__(
        self, action: PhaseAction, context: PhaseExecutionContext, substep: PhaseSubstep | None
    ) -> None:
        self.action, self.context, self.substep = action, context, substep
        self.actor = _id(context.user_ids, "admin", label="file actor", step=action.key)
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []
        self.reads = 0
        self.page_counts: dict[str, int] = {}
        self.digests: dict[str, str] = {}
        self.normalized_sizes: dict[str, int] = {}

    def request(
        self,
        method: str,
        path: str,
        step: str,
        *,
        expected: int = 200,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
        content: bytes | None = None,
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
            content=content,
            headers={"Content-Type": "application/octet-stream"} if content is not None else None,
        )
        if method == "GET":
            request_id = _request_id(response)
            if request_id is None:
                raise SamplePhaseActionError(
                    "File read has no canonical request identity", step=step
                )
            self.reads += 1
            self.evidence.append(
                dict(
                    step=step,
                    actor_key="admin",
                    actor_id=self.actor,
                    method=method,
                    path=path,
                    expected_status=expected,
                    status_code=response.status_code,
                    request_id=request_id,
                )
            )
        return response

    def get(self, path: str, step: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return _read_json(self.request("GET", path, step, params=params), step=step)

    def meta(
        self,
        body: Mapping[str, Any],
        key: str,
        parent: str | None,
        state: str,
        deleted: bool,
        step: str,
    ) -> dict[str, Any]:
        purpose = "workspace_logo" if key.startswith("logo_") else key
        identifier = self.context.runtime_mappings.get("generic_files", {}).get(FILE_KEYS[key])
        row = file_metadata(
            body,
            file_id=identifier,
            purpose=purpose,
            parent_id=parent,
            filename=FILE_NAMES[key],
            actor_id=self.actor,
            state=state,
            deleted=deleted,
            step=step,
            expected_actual_size=self.normalized_sizes.get(key),
        )
        if state != "awaiting_upload":
            self.normalized_sizes.setdefault(key, row["actual_size"])
        return row

    def reserve_upload(self, key: str, parent: str | None) -> dict[str, Any]:
        if FILE_KEYS[key] in self.context.runtime_mappings.get("generic_files", {}):
            raise SamplePhaseActionError(
                "Owned file already has a reservation; reconcile before continuing", step=key
            )
        purpose = "workspace_logo" if key.startswith("logo_") else key
        content = dummy_file(FILE_NAMES[key])
        body: dict[str, Any] = {
            "purpose": purpose,
            "filename": FILE_NAMES[key],
            "expected_size": len(content),
        }
        if purpose != "workspace_logo":
            body["record_id" if purpose == "record_attachment" else "department_id"] = parent
        response = self.request("POST", "/api/files", f"{key}_reserve", expected=201, body=body)
        row = self.meta(_read_json(response, step=key), key, parent, "awaiting_upload", False, key)
        identifier = _id(row, "id", label="reserved file", step=key)
        _record_mapping(
            self.context,
            self.context.clients["admin"],
            "generic_files",
            FILE_KEYS[key],
            identifier,
            self.mappings,
        )
        response = self.request(
            "PUT", f"/api/files/{identifier}/content", f"{key}_upload", content=content
        )
        row = self.meta(_read_json(response, step=key), key, parent, "ready", False, key)
        self.inventory(key, parent, False, f"{key}_list")
        return self.read_file(key, parent, False, f"{key}_detail")

    def identifier(self, key: str) -> str:
        return _mapped_id(self.context, "generic_files", FILE_KEYS[key], step=key)

    def read_file(
        self, key: str, parent: str | None, deleted: bool, step: str, *, state: str = "ready"
    ) -> dict[str, Any]:
        return self.meta(
            self.get(f"/api/files/{self.identifier(key)}", step), key, parent, state, deleted, step
        )

    def inventory(self, key: str, parent: str | None, deleted: bool, step: str) -> None:
        purpose = "workspace_logo" if key.startswith("logo_") else key
        params: dict[str, Any] = {
            "purpose": purpose,
            "deleted": "only" if deleted else "exclude",
            "sort_by": "created_at",
            "sort_order": "desc",
            "limit": 100,
        }
        if purpose != "workspace_logo":
            params["record_id" if purpose == "record_attachment" else "department_id"] = parent
        seen: set[str] = set()
        total = None
        found = False
        for page in range(100):
            offset = page * 100
            body = self.get("/api/files", f"{step}_{offset}", {**params, "offset": offset})
            rows = file_page(body, purpose=purpose, offset=offset, step=step)
            if total is not None and total != body["pagination"]["total"]:
                raise SamplePhaseActionError("File inventory changed during traversal", step=step)
            total = body["pagination"]["total"]
            for row in rows:
                identifier = _id(row, "id", label="listed file", step=step)
                if identifier in seen:
                    raise SamplePhaseActionError("File inventory repeats an identity", step=step)
                seen.add(identifier)
                if identifier == self.identifier(key):
                    self.meta(row, key, parent, "ready", deleted, step)
                    found = True
            if body["pagination"]["has_more"] is False:
                self.page_counts[step] = page + 1
                if not found:
                    raise SamplePhaseActionError(
                        "Owned file is absent from its inventory", step=step
                    )
                return
        raise SamplePhaseActionError("File inventory exceeds its bounded traversal", step=step)

    def download(
        self, key: str, row: Mapping[str, Any], step: str, *, inline: bool = False
    ) -> None:
        path = "/api/workspace/logo" if inline else f"/api/files/{self.identifier(key)}/content"
        digest = check_download(
            self.request("GET", path, step),
            row,
            filename=FILE_NAMES[key],
            purpose="workspace_logo" if key.startswith("logo_") else key,
            step=step,
            inline=inline,
        )
        previous = self.digests.get(key)
        if previous is not None and digest != previous:
            raise SamplePhaseActionError("Owned file digest changed between readbacks", step=step)
        self.digests[key] = digest

    def archive(self, key: str, parent: str, *, reopen: bool = False) -> None:
        command = "reopen" if reopen else "archive"
        response = self.request(
            "POST", f"/api/files/{self.identifier(key)}/{command}", f"{key}_{command}"
        )
        self.meta(_read_json(response, step=command), key, parent, "ready", not reopen, command)
        self.read_file(key, parent, not reopen, f"{key}_{command}_detail")
        self.inventory(key, parent, not reopen, f"{key}_{command}_list")

    def workspace(
        self, step: str, original: Mapping[str, Any] | None = None, logo: str | None = None
    ) -> dict[str, Any]:
        body = workspace_profile(self.get("/api/workspace", step), step)
        if original is not None and (
            body["id"] != original["id"]
            or body["theme"] != original["theme"]
            or body["logo_file_id"] != logo
        ):
            raise SamplePhaseActionError("Workspace logo binding or theme changed", step=step)
        return body

    def bind(
        self, original: Mapping[str, Any], previous: str | None, new: str | None
    ) -> dict[str, Any]:
        before = self.workspace(f"workspace_before_{new or 'restore'}", original, previous)
        response = self.request(
            "PATCH",
            "/api/workspace",
            f"workspace_bind_{new or 'restore'}",
            body={"revision": before["revision"], "logo_file_id": new},
        )
        body = workspace_profile(_read_json(response, step="workspace_bind"), "workspace_bind")
        if (
            body["id"] != original["id"]
            or body["logo_file_id"] != new
            or body["theme"] != original["theme"]
            or body["revision"] != before["revision"] + 1
        ):
            raise SamplePhaseActionError(
                "Workspace logo acknowledgment differs", step="workspace_bind"
            )
        return self.workspace(f"workspace_binding_readback_{new or 'restore'}", original, new)


def execute_file_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_file_controls(dataset):
        raise SamplePhaseActionError("File control differs from its authored plan", step=action.key)
    run = _Run(action, context, on_substep)
    operation = action.values["operation"]
    extra: dict[str, object] = dict(action.expected_end_state)
    if operation != "workspace_logo_files":
        key = str(action.values["purpose"])
        parent_kind = "records" if key == "record_attachment" else "department"
        parent_key = str(
            action.values["record_key" if key == "record_attachment" else "department_key"]
        )
        parent = _mapped_id(context, parent_kind, parent_key, step=action.key)
        path = f"/api/{'records' if key == 'record_attachment' else 'departments'}/{parent}"
        body = run.get(path, f"{key}_parent")
        if body.get("id") != parent or body.get("is_deleted") is not False:
            raise SamplePhaseActionError(
                "Owned file parent differs or is archived", step=action.key
            )
        if key == "record_attachment" and body.get("module_id") != _mapped_id(
            context, "modules", str(action.values["module_key"]), step=action.key
        ):
            raise SamplePhaseActionError("Owned file record has another module", step=action.key)
        row = run.reserve_upload(key, parent)
        run.download(key, row, f"{key}_content")
        run.archive(key, parent)
        if key == "library_document":
            run.archive(key, parent, reopen=True)
            run.download(
                key,
                run.read_file(key, parent, False, "library_reopened"),
                "library_reopened_content",
            )
    else:
        original = run.workspace("workspace_before_files")
        if original["logo_file_id"] is not None:
            raise SamplePhaseActionError(
                "Existing human logo prevents owned file controls", step="workspace_before_files"
            )
        primary = run.reserve_upload("logo_primary", None)
        response = run.request(
            "POST",
            f"/api/files/{run.identifier('logo_primary')}/reconcile",
            "logo_primary_reconcile",
        )
        run.meta(
            _read_json(response, step="reconcile"),
            "logo_primary",
            None,
            "ready",
            False,
            "reconcile",
        )
        run.download("logo_primary", primary, "logo_primary_content")
        run.bind(original, None, run.identifier("logo_primary"))
        run.download("logo_primary", primary, "logo_primary_inline", inline=True)
        run.workspace("logo_primary_delivery_binding", original, run.identifier("logo_primary"))
        replacement = run.reserve_upload("logo_replacement", None)
        run.download("logo_replacement", replacement, "logo_replacement_content")
        run.bind(original, run.identifier("logo_primary"), run.identifier("logo_replacement"))
        old = run.read_file("logo_primary", None, True, "logo_primary_purged", state="purged")
        if old["state"] != "purged" or old["is_deleted"] is not True:
            raise SamplePhaseActionError(
                "Owned prior logo was not purged", step="logo_primary_purged"
            )
        run.download("logo_replacement", replacement, "logo_replacement_inline", inline=True)
        run.workspace(
            "logo_replacement_delivery_binding", original, run.identifier("logo_replacement")
        )
        run.bind(original, run.identifier("logo_replacement"), None)
        old = run.read_file(
            "logo_replacement", None, True, "logo_replacement_purged", state="purged"
        )
        if old["state"] != "purged" or old["is_deleted"] is not True:
            raise SamplePhaseActionError(
                "Owned replacement logo was not purged", step="logo_replacement_purged"
            )
        extra.update(
            original_theme=original["theme"],
            original_revision=original["revision"],
            workspace_id=original["id"],
        )
    extra.update(read_checks=run.reads, file_pages=run.page_counts, file_digests=run.digests)
    return _result(
        action,
        context,
        [{key: row[key] for key in EVIDENCE_KEYS} for row in run.evidence],
        run.mappings,
        extra=extra,
    )
