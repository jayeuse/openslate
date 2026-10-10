"""Confirmed disposal of the two owned, detached Board control files."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from app.systems.platform.files.schemas import FileListResponse, FileResponse
from app.systems.sandbox.lifecycle.schemas import (
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
)
from operations.sample.controls.board_content import _string
from operations.sample.controls.board_files import _file_body, _files, _Run
from operations.sample.controls.platform_verification import validate_platform_page
from operations.sample.dummy_files import dummy_file
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _request_id,
    _result,
)


def validate_board_file_state(
    body: Mapping[str, Any],
    *,
    file_id: str,
    board_id: str,
    filename: str,
    creator_id: str,
    state: str,
    deleted: bool,
    step: str,
) -> dict[str, Any]:
    """Validate fresh DTO and expected ownership for producer and final readback."""
    try:
        file = FileResponse.model_validate(body)
    except ValidationError:
        raise SamplePhaseActionError(
            "Board file identity or metadata is invalid", step=step
        ) from None
    if (
        str(file.id) != file_id
        or str(file.board_id) != board_id
        or file.purpose != "board_attachment"
        or file.record_id is not None
        or file.department_id is not None
        or file.filename != filename
        or str(file.creator_id) != creator_id
        or file.state != state
        or body.get("is_deleted") is not deleted
        or file.expected_size != len(dummy_file(filename))
        or file.actual_size != file.expected_size
        or file.failure_code is not None
    ):
        raise SamplePhaseActionError("Board file identity or end state differs", step=step)
    return dict(body)


def _file_state(
    run: _Run, response: Any, file_id: str, filename: str, step: str, *, state: str, deleted: bool
) -> dict[str, Any]:
    body = _file_body(response, file_id=file_id, step=step)
    creator = _id(
        run.context.user_ids,
        _string(run.action.values, "source_actor", step=step),
        label="user",
        step=step,
    )
    return validate_board_file_state(
        body,
        file_id=file_id,
        board_id=run.board_id,
        filename=filename,
        creator_id=creator,
        state=state,
        deleted=deleted,
        step=step,
    )


def _purge_files(run: _Run) -> None:
    if (
        run.action.actor_key != "admin"
        or run.action.target_key != "control:files"
        or [key for key, _ in _files(run.action)] != ["control:post-file", "control:event-file"]
    ):
        raise SamplePhaseActionError(
            "Board file purge requires its owned admin action", step=run.action.key
        )
    for number, (file_key, filename) in enumerate(_files(run.action), start=1):
        file_id = _mapped_id(run.context, "control_files", file_key, step=run.action.key)
        base = f"/api/boards/{run.board_id}/files/{file_id}"

        def file_step(suffix: str, index: int = number) -> str:
            return f"board_file_{index}_{suffix}"

        response = run.send("GET", base, file_step("original"), 200)
        _file_state(
            run, response, file_id, filename, file_step("original"), state="ready", deleted=False
        )
        response = run.send("POST", base + "/archive", file_step("archive"), 200)
        _file_state(
            run, response, file_id, filename, file_step("archive"), state="ready", deleted=True
        )
        offset, found = 0, False
        total: int | None = None
        seen: set[str] = set()
        while offset < 10000:
            step = file_step(f"archived_page_{offset}")
            page = run.read(
                f"/api/boards/{run.board_id}/files",
                step,
                {"deleted": "only", "limit": 100, "offset": offset},
            )
            rows = validate_platform_page(page, 100, step, offset=offset)
            try:
                parsed = FileListResponse.model_validate(page)
            except ValidationError:
                raise SamplePhaseActionError(
                    "Archived Board file page is invalid", step=step
                ) from None
            identifiers = {str(file.id) for file in parsed.items}
            if (
                any(
                    str(file.board_id) != run.board_id
                    or file.purpose != "board_attachment"
                    or file.record_id is not None
                    or file.department_id is not None
                    or row.get("is_deleted") is not True
                    for file, row in zip(parsed.items, rows, strict=True)
                )
                or len(identifiers) != len(rows)
                or seen & identifiers
                or (total is not None and total != parsed.pagination.total)
                or parsed.pagination.total > 10000
            ):
                raise SamplePhaseActionError(
                    "Archived Board file page ownership or pagination differs", step=step
                )
            total = parsed.pagination.total
            seen.update(identifiers)
            if any(
                row.get("id") == file_id
                and row.get("board_id") == run.board_id
                and row.get("filename") == filename
                and row.get("is_deleted") is True
                for row in rows
            ):
                found = True
                break
            if not page["pagination"]["has_more"]:
                break
            offset += len(rows)
        if not found:
            raise SamplePhaseActionError(
                "Owned Board file is absent from archived list", step=file_step("archived_list")
            )
        step = file_step("preview")
        response = run.send("POST", base + "/purge/preview", step, 200)
        try:
            preview = LifecyclePurgePreviewResponse.model_validate(
                _read_json(response, step=step, request_id=_request_id(response))
            )
            payload = LifecyclePurgeRequest(
                token=preview.token,
                confirmation_name=preview.confirmation_name,
                password=run.context.admin_password,
            )
        except ValidationError:
            raise SamplePhaseActionError("Board file purge preview is invalid", step=step) from None
        if (
            preview.impact.target_type != "file"
            or str(preview.impact.target_id) != file_id
            or preview.impact.operation != "purge"
            or preview.impact.blockers
            or str(preview.impact.actor_id) != run.context.user_ids.get("admin")
            or preview.confirmation_name != filename
            or preview.expires_at.utcoffset() is None
            or preview.expires_at <= datetime.now(UTC)
        ):
            raise SamplePhaseActionError("Board file purge preview identity differs", step=step)
        step = file_step("purge")
        response = run.send("POST", base + "/purge", step, 200, json_body=payload.model_dump())
        _file_state(run, response, file_id, filename, step, state="purged", deleted=True)
        step = file_step("readback")
        _file_state(
            run,
            run.send("GET", base, step, 200),
            file_id,
            filename,
            step,
            state="purged",
            deleted=True,
        )


def execute_board_file_purge(
    action: PhaseAction, context: PhaseExecutionContext, *, on_substep: PhaseSubstep | None
) -> dict[str, object]:
    run = _Run(action, context, on_substep)
    _purge_files(run)
    return _result(
        action,
        context,
        run.evidence,
        run.mappings,
        extra={"operation": "board_files_archive_purge", "files_purged": 2},
    )
