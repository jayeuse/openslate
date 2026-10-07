"""Independent file metadata, byte delivery, evidence and final-state checks."""

from __future__ import annotations

from collections.abc import Mapping
from hashlib import sha256
from io import BytesIO
from typing import Any
from urllib.parse import quote

import httpx
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from app.systems.manage.workspace.schemas import WorkspaceResponse
from app.systems.platform.files.schemas import FileResponse, LibraryFileListResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.platform_verification import validate_platform_page
from operations.sample.dummy_files import MEDIA_TYPES, dummy_file, extension_of
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError
from operations.sample.verification.core import SampleVerificationError, list_all_rows


def file_metadata(
    body: Mapping[str, Any],
    *,
    file_id: str | None,
    purpose: str,
    parent_id: str | None,
    filename: str,
    actor_id: str,
    state: str,
    deleted: bool,
    step: str,
    expected_actual_size: int | None = None,
) -> dict[str, Any]:
    try:
        file = FileResponse.model_validate(body)
    except ValidationError:
        raise SamplePhaseActionError("File response is invalid", step=step) from None
    expected_size = len(dummy_file(filename))
    parents = (
        str(file.record_id) if file.record_id else None,
        str(file.department_id) if file.department_id else None,
    )
    expected_parents = (
        (parent_id, None)
        if purpose == "record_attachment"
        else (None, parent_id)
        if purpose == "library_document"
        else (None, None)
    )
    ready = state != "awaiting_upload"
    if (
        (file_id is not None and str(file.id) != file_id)
        or file.purpose != purpose
        or parents != expected_parents
        or file.board_id is not None
        or str(file.creator_id) != actor_id
        or file.filename != filename
        or file.state != state
        or body.get("is_deleted") is not deleted
        or file.failure_code is not None
        or type(body.get("expected_size")) is not int
        or file.expected_size != expected_size
        or (
            ready
            and (
                type(body.get("actual_size")) is not int
                or (file.actual_size or 0) <= 0
                or file.media_type != MEDIA_TYPES[extension_of(filename)]
            )
        )
        or (ready and purpose != "workspace_logo" and file.actual_size != expected_size)
        or (ready and expected_actual_size is not None and file.actual_size != expected_actual_size)
        or (ready and purpose == "workspace_logo" and (file.actual_size or 0) > 2 * 1024 * 1024)
        or (not ready and (file.actual_size is not None or file.media_type is not None))
    ):
        raise SamplePhaseActionError("Owned file identity, parent or metadata differs", step=step)
    return dict(body)


def workspace_profile(body: Mapping[str, Any], step: str) -> dict[str, Any]:
    try:
        WorkspaceResponse.model_validate(body)
    except ValidationError:
        raise SamplePhaseActionError("Workspace file profile is invalid", step=step) from None
    if type(body.get("revision")) is not int or body["revision"] < 1:
        raise SamplePhaseActionError("Workspace revision is invalid", step=step)
    return dict(body)


def file_page(
    body: Mapping[str, Any], *, purpose: str, offset: int, step: str
) -> list[dict[str, Any]]:
    rows = validate_platform_page(body, 100, step, offset=offset)
    if purpose == "library_document":
        try:
            LibraryFileListResponse.model_validate(body)
        except ValidationError:
            raise SamplePhaseActionError("Library file page is invalid", step=step) from None
    return rows


def check_download(
    response: httpx.Response,
    file: Mapping[str, Any],
    *,
    filename: str,
    purpose: str,
    step: str,
    inline: bool = False,
) -> str:
    media = MEDIA_TYPES[extension_of(filename)]
    headers = response.headers
    if (
        response.status_code != 200
        or headers.get("Content-Type", "").partition(";")[0].strip().lower() != media
        or headers.get("X-Content-Type-Options", "").lower() != "nosniff"
        or "no-store"
        not in {part.strip().lower() for part in headers.get("Cache-Control", "").split(",")}
        or (
            not inline
            and headers.get("Content-Disposition")
            != "attachment; filename*=UTF-8''" + quote(filename, safe="")
        )
        or not response.content
        or len(response.content) != file.get("actual_size")
    ):
        raise SamplePhaseActionError("File download headers or size differ", step=step)
    expected = dummy_file(filename)
    if purpose == "workspace_logo":
        if len(response.content) > 2 * 1024 * 1024:
            raise SamplePhaseActionError("Logo download exceeds its bound", step=step)
        try:
            with (
                Image.open(BytesIO(expected)) as source,
                Image.open(BytesIO(response.content)) as logo,
            ):
                if (
                    logo.format != source.format
                    or logo.size != source.size
                    or getattr(logo, "n_frames", 1) != 1
                    or logo.convert("RGBA").tobytes() != source.convert("RGBA").tobytes()
                ):
                    raise SamplePhaseActionError(
                        "Logo pixels differ from the owned upload", step=step
                    )
        except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
            raise SamplePhaseActionError("Logo download is invalid", step=step) from None
    elif response.content != expected:
        raise SamplePhaseActionError("File bytes differ from the owned upload", step=step)
    return sha256(response.content).hexdigest()


def _request_contract(
    action: PhaseAction, mappings: Mapping[str, Any], pages: Mapping[str, Any]
) -> list[tuple[str, str, str, int]]:
    from operations.sample.controls.files import FILE_KEYS
    from operations.sample.controls.request_verification import _canonical_uuid

    files = mappings.get("generic_files", {})
    expected: list[tuple[str, str, str, int]] = []
    used_pages: set[str] = set()

    def identifier(key: str) -> str:
        value = files.get(FILE_KEYS[key]) if isinstance(files, Mapping) else None
        result = _canonical_uuid(value)
        if result is None:
            raise ValueError("Missing owned file identity")
        return result

    def add(step: str, method: str, path: str, status: int = 200) -> None:
        expected.append((step, method, path, status))

    def inventory(step: str) -> None:
        count = pages.get(step)
        if type(count) is not int or not 1 <= count <= 100:
            raise ValueError("Invalid file page count")
        used_pages.add(step)
        for offset in range(count):
            add(f"{step}_{offset * 100}", "GET", "/api/files")

    def upload(key: str) -> None:
        add(f"{key}_reserve", "POST", "/api/files", 201)
        add(f"{key}_upload", "PUT", f"/api/files/{identifier(key)}/content")
        inventory(f"{key}_list")
        add(f"{key}_detail", "GET", f"/api/files/{identifier(key)}")

    def bind(key: str | None) -> None:
        suffix = identifier(key) if key else "restore"
        add(f"workspace_before_{suffix}", "GET", "/api/workspace")
        add(f"workspace_bind_{suffix}", "PATCH", "/api/workspace")
        add(f"workspace_binding_readback_{suffix}", "GET", "/api/workspace")

    operation = action.values["operation"]
    if operation == "workspace_logo_files":
        add("workspace_before_files", "GET", "/api/workspace")
        upload("logo_primary")
        add("logo_primary_reconcile", "POST", f"/api/files/{identifier('logo_primary')}/reconcile")
        add("logo_primary_content", "GET", f"/api/files/{identifier('logo_primary')}/content")
        bind("logo_primary")
        add("logo_primary_inline", "GET", "/api/workspace/logo")
        add("logo_primary_delivery_binding", "GET", "/api/workspace")
        upload("logo_replacement")
        add(
            "logo_replacement_content",
            "GET",
            f"/api/files/{identifier('logo_replacement')}/content",
        )
        bind("logo_replacement")
        add("logo_primary_purged", "GET", f"/api/files/{identifier('logo_primary')}")
        add("logo_replacement_inline", "GET", "/api/workspace/logo")
        add("logo_replacement_delivery_binding", "GET", "/api/workspace")
        bind(None)
        add("logo_replacement_purged", "GET", f"/api/files/{identifier('logo_replacement')}")
    else:
        key = str(action.values["purpose"])
        bucket = "records" if key == "record_attachment" else "departments"
        logical = action.values["record_key" if bucket == "records" else "department_key"]
        parent_rows = mappings.get(bucket, {})
        parent = parent_rows.get(logical) if isinstance(parent_rows, Mapping) else None
        if _canonical_uuid(parent) is None:
            raise ValueError("Missing file parent identity")
        add(f"{key}_parent", "GET", f"/api/{bucket}/{parent}")
        upload(key)
        add(f"{key}_content", "GET", f"/api/files/{identifier(key)}/content")
        for command in ("archive", "reopen") if key == "library_document" else ("archive",):
            add(f"{key}_{command}", "POST", f"/api/files/{identifier(key)}/{command}")
            add(f"{key}_{command}_detail", "GET", f"/api/files/{identifier(key)}")
            inventory(f"{key}_{command}_list")
        if key == "library_document":
            add("library_reopened", "GET", f"/api/files/{identifier(key)}")
            add("library_reopened_content", "GET", f"/api/files/{identifier(key)}/content")
    if set(pages) != used_pages:
        raise ValueError("Unexpected file inventory evidence")
    return expected


def verify_file_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.controls.files import EVIDENCE_KEYS, plan_file_controls
    from operations.sample.controls.request_verification import _canonical_uuid

    rows, pages, mappings = (
        result.get("request_evidence"),
        result.get("file_pages"),
        manifest.get("mappings"),
    )
    if (
        action not in plan_file_controls(dataset)
        or not isinstance(rows, list)
        or not rows
        or not isinstance(pages, Mapping)
        or not isinstance(mappings, Mapping)
        or result.get("outcome") != "completed"
        or any(
            type(result.get(key)) is not type(value) or result.get(key) != value
            for key, value in action.expected_end_state.items()
        )
    ):
        issues.append("File control plan or end state differs")
        return
    try:
        expected = _request_contract(action, mappings, pages)
    except (ValueError, KeyError):
        issues.append("File request mappings or page evidence differs")
        return
    if (
        len(rows) != len(expected)
        or type(result.get("read_checks")) is not int
        or result["read_checks"] != sum(method == "GET" for _, method, _, _ in expected)
    ):
        issues.append("File request sequence or read count differs")
        return
    pending: set[str] = set()
    for row, receipt in zip(rows, expected, strict=True):
        if not isinstance(row, Mapping) or set(row) != set(EVIDENCE_KEYS):
            issues.append("File request evidence fields differ")
            return
        request_id = _canonical_uuid(row.get("request_id"))
        if (
            row.get("actor_key") != "admin"
            or row.get("actor_id") != admin_id
            or row.get("status_code") != row.get("expected_status")
            or tuple(row.get(k) for k in ("step", "method", "path", "expected_status")) != receipt
            or request_id is None
            or request_id in seen_request_ids
            or request_id in pending
        ):
            issues.append("File request evidence is not bound to the successful actor")
            return
        pending.add(request_id)
    seen_request_ids.update(pending)
    observed["control_requests_verified"] += len(rows)


def verify_file_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    from operations.sample.controls.files import FILE_KEYS, FILE_NAMES, plan_file_controls

    counts = dict.fromkeys(
        ("record_files_archived", "library_files_reopened", "logos_purged", "workspace_restored"), 0
    )
    issues: list[str] = []
    mappings = manifest.get("mappings", {})
    files = mappings.get("generic_files", {}) if isinstance(mappings, Mapping) else {}
    results = manifest.get("control_results", [])
    if not isinstance(files, Mapping) or not isinstance(results, list):
        return counts, ["File control mappings or results are missing"]
    try:
        for action in plan_file_controls(dataset):
            operation = action.values["operation"]
            purposes = (
                ("logo_primary", "logo_replacement")
                if operation == "workspace_logo_files"
                else (str(action.values["purpose"]),)
            )
            for key in purposes:
                identifier = files.get(FILE_KEYS[key])
                response = admin.request("GET", f"/api/files/{identifier}")
                if response.status_code != 200 or not isinstance(response.json(), dict):
                    issues.append("Owned file final state is unavailable")
                    continue
                body = response.json()
                purpose = "workspace_logo" if key.startswith("logo_") else key
                parent_kind = "records" if purpose == "record_attachment" else "departments"
                logical_parent = action.values.get(
                    "record_key", action.values.get("department_key")
                )
                parent_rows = mappings.get(parent_kind, {}) if isinstance(mappings, Mapping) else {}
                parent_id = (
                    parent_rows.get(logical_parent) if isinstance(parent_rows, Mapping) else None
                )
                file_metadata(
                    body,
                    file_id=identifier,
                    purpose=purpose,
                    parent_id=parent_id,
                    filename=FILE_NAMES[key],
                    actor_id=admin_id,
                    state="purged" if purpose == "workspace_logo" else "ready",
                    deleted=purpose != "library_document",
                    step="final_file",
                )
                params: dict[str, Any] = {
                    "purpose": purpose,
                    "deleted": "include",
                    "sort_by": "created_at",
                    "sort_order": "desc",
                }
                if purpose != "workspace_logo":
                    params["record_id" if purpose == "record_attachment" else "department_id"] = (
                        parent_id
                    )
                inventory = list_all_rows(admin, "/api/files", params=params)
                matches = [r for r in inventory if r.get("id") == identifier]
                if len(matches) != 1:
                    raise SamplePhaseActionError(
                        "Owned file is absent from final inventory", step="final_file"
                    )
                file_metadata(
                    matches[0],
                    file_id=identifier,
                    purpose=purpose,
                    parent_id=parent_id,
                    filename=FILE_NAMES[key],
                    actor_id=admin_id,
                    state="purged" if purpose == "workspace_logo" else "ready",
                    deleted=purpose != "library_document",
                    step="final_file_list",
                    expected_actual_size=body["actual_size"],
                )
                if purpose == "workspace_logo":
                    counts["logos_purged"] += 1
                else:
                    download = admin.request("GET", f"/api/files/{identifier}/content")
                    check_download(
                        download,
                        body,
                        filename=FILE_NAMES[key],
                        purpose=purpose,
                        step="final_content",
                    )
                    counts[
                        "record_files_archived"
                        if purpose == "record_attachment"
                        else "library_files_reopened"
                    ] += 1
            if operation == "workspace_logo_files":
                result: object = next(
                    (
                        r.get("safe_result", r)
                        for r in results
                        if isinstance(r, Mapping) and r.get("action_key") == action.key
                    ),
                    {},
                )
                response = admin.request("GET", "/api/workspace")
                body = workspace_profile(response.json(), "final_workspace")
                if (
                    not isinstance(result, Mapping)
                    or type(result.get("original_revision")) is not int
                    or response.status_code != 200
                    or body.get("logo_file_id") is not None
                    or body.get("theme") != result.get("original_theme")
                    or body.get("id") != result.get("workspace_id")
                    or body["revision"] < result["original_revision"] + 3
                ):
                    issues.append("Workspace logo or theme was not restored")
                else:
                    counts["workspace_restored"] = 1
    except (
        SampleClientError,
        SamplePhaseActionError,
        SampleVerificationError,
        ValueError,
        TypeError,
    ):
        issues.append("File final readback is unavailable or differs")
    return counts, issues
