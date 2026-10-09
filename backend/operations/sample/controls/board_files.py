"""Owned Board file controls on the authored anchor Board.

Six author actions reserve/upload/attach/detach two temporary files. The final
administrator action archives and purges those files, preserving authored content.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.board_content import _revision, _string
from operations.sample.dummy_files import dummy_file
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _request_object,
    _result,
)
from operations.sample.phases.planning import _board_level
from operations.sample.population.board_files import UPLOAD_HEADERS, download_issue, readback_files
from operations.sample.population.boards import project_board_logical_id

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset

BOARD_FILE_ROUTES = frozenset(
    {
        ("POST", "/api/boards/{board_id}/files"),
        ("GET", "/api/boards/{board_id}/files"),
        ("GET", "/api/boards/{board_id}/files/{file_id}"),
        ("GET", "/api/boards/{board_id}/files/{file_id}/content"),
        ("POST", "/api/boards/{board_id}/files/{file_id}/archive"),
        ("POST", "/api/boards/{board_id}/files/{file_id}/purge/preview"),
        ("POST", "/api/boards/{board_id}/files/{file_id}/purge"),
        ("PUT", "/api/boards/{board_id}/files/{file_id}/content"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/attachments"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/attachments"),
        ("DELETE", "/api/boards/{board_id}/posts/{post_id}/attachments/{file_id}"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/attachments/{file_id}/content"),
        ("GET", "/api/boards/{board_id}/events/{event_id}/attachments"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/attachments"),
        ("DELETE", "/api/boards/{board_id}/events/{event_id}/attachments/{file_id}"),
        ("GET", "/api/boards/{board_id}/events/{event_id}/attachments/{file_id}/content"),
    }
)
FILE_OPERATIONS = frozenset(
    {
        "board_files_archive_purge",
        "board_file_reserve",
        "board_file_upload",
        "post_attachment_create",
        "post_attachment_delete",
        "event_attachment_create",
        "event_attachment_delete",
    }
)
_POST_FILE, _EVENT_FILE = "control:post-file", "control:event-file"


def board_author(dataset: SampleDataset, department: str, board_name: str, offset: int) -> str:
    """Use the same authored rotation as the ordinary Board content queue: post index i
    has offset i and event index j has offset j + 1 (`plan_board_steps`)."""
    pack = dataset.organization
    people = {person.key: person for person in pack.actors.people}
    authors = [
        key
        for key in pack.actors.team_keys[department]
        if people[key].status == "active"
        and people[key].role == "member"
        and _board_level(pack, key, department) >= 2
    ] or ["admin"]
    board_index = (
        1
        + len(pack.catalog.departments)
        + pack.content.data.projects.index((board_name, department))
    )
    return authors[(board_index * 3 + offset) % len(authors)]


def plan_board_file_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    pack = dataset.organization
    if pack.phases is None:
        return ()
    content = pack.content.data
    board_name, department = pack.phases.existing_project_board
    board_key = project_board_logical_id(department, board_name)
    post_index = next(
        (i for i in range(content.posts_per_board) if content.post_states[i // 2] == "draft"),
        None,
    )
    names = [item.filename for item in readback_files(pack)[:2]]
    if post_index is None or content.events_per_board < 1 or len(names) < 2:
        raise ValueError("File controls need a seeded draft post, an event and two file types")
    author = board_author(dataset, department, board_name, post_index)
    event_index = next(
        (
            j
            for j in range(content.events_per_board)
            if board_author(dataset, department, board_name, j + 1) == author
        ),
        None,
    )
    actor = author if event_index is not None else "admin"
    event_index = event_index or 0
    post_key = f"{board_key}:post:{post_index + 1:02d}"
    event_key = f"{board_key}:event:{event_index + 1:02d}"
    files: list[PhaseJsonValue] = [
        {"file_key": _POST_FILE, "filename": names[0]},
        {"file_key": _EVENT_FILE, "filename": names[1]},
    ]

    def action(
        operation: str,
        suffix: str,
        target: str,
        values: Mapping[str, PhaseJsonValue],
        end: Mapping[str, PhaseJsonValue],
        status: int,
        actor_key: str = actor,
    ) -> PhaseAction:
        return PhaseAction(
            key=f"control:board:{suffix}",
            phase="reorganization",
            kind="board_controls",
            actor_key=actor_key,
            target_key=target,
            values={"operation": operation, "board_key": board_key, **values},
            expected_status=status,
            expected_detail=None,
            expected_end_state=dict(end),
        )

    post = {"content_key": post_key, "file_key": _POST_FILE, "filename": names[0]}
    event = {"content_key": event_key, "file_key": _EVENT_FILE, "filename": names[1]}
    return (
        action("board_file_reserve", "reserve-files", "control:files", {"files": files},
               {"state": "awaiting_upload"}, 201),
        action("board_file_upload", "upload-files", "control:files", {"files": files},
               {"state": "ready"}, 200),
        action("post_attachment_create", "attach-post-file", _POST_FILE, post,
               {"listed": True}, 200),
        action("post_attachment_delete", "detach-post-file", _POST_FILE, post,
               {"listed": False}, 204),
        action("event_attachment_create", "attach-event-file", _EVENT_FILE, event,
               {"listed": True}, 200),
        action("event_attachment_delete", "detach-event-file", _EVENT_FILE, event,
               {"listed": False}, 204),
        action("board_files_archive_purge", "purge-files", "control:files",
               {"files": files, "source_actor": actor}, {"files_purged": 2}, 200, "admin"),
    )  # fmt: skip


def _files(action: PhaseAction) -> list[tuple[str, str]]:
    rows = action.values.get("files")
    if not isinstance(rows, list) or not rows:
        raise SamplePhaseActionError("Planned Board files are invalid", step=action.key)
    result = []
    for row in rows:
        if not isinstance(row, Mapping):
            raise SamplePhaseActionError("Planned Board files are invalid", step=action.key)
        result.append(
            (_string(row, "file_key", step=action.key), _string(row, "filename", step=action.key))
        )
    return result


def _file_body(response: Any, *, file_id: str | None, step: str) -> dict[str, Any]:
    body = _read_json(response, step=step, request_id=_request_id(response))
    if file_id is not None and body.get("id") != file_id:
        raise SamplePhaseActionError("Board file response names another file", step=step)
    return body


class _Run:
    def __init__(
        self,
        action: PhaseAction,
        context: PhaseExecutionContext,
        on_substep: PhaseSubstep | None,
    ) -> None:
        self.action, self.context, self.on_substep = action, context, on_substep
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []
        board_key = _string(action.values, "board_key", step=action.key)
        self.board_id = _mapped_id(context, "boards", board_key, step=action.key)

    def send(self, method: str, path: str, step: str, expected: int, **kwargs: Any) -> Any:
        return _request(self.action, self.context, self.evidence, actor_key=self.action.actor_key,
                        method=method, path=path, step=step, expected=expected,
                        on_substep=self.on_substep, **kwargs)  # fmt: skip

    def read(self, path: str, step: str, params: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return _request_object(self.action, self.context, self.evidence,
                               actor_key=self.action.actor_key, path=path, step=step,
                               on_substep=self.on_substep, params=params)  # fmt: skip

    def reserve(self) -> None:
        for number, (file_key, filename) in enumerate(_files(self.action), start=1):
            step = f"reserve_board_file_{number}"
            response = self.send(
                "POST",
                f"/api/boards/{self.board_id}/files",
                step,
                201,
                json_body={"filename": filename, "expected_size": len(dummy_file(filename))},
            )
            body = _file_body(response, file_id=None, step=step)
            file_id = _id(body, "id", label="Board file", step=step)
            if body.get("state") != "awaiting_upload" or body.get("board_id") != self.board_id:
                raise SamplePhaseActionError(
                    "Board file reservation is not awaiting its upload", step=step
                )
            client = _client(self.context, self.action.actor_key, step="board_file_mapping")
            _record_mapping(self.context, client, "control_files", file_key, file_id,
                            self.mappings)  # fmt: skip

    def upload(self) -> None:
        for number, (file_key, filename) in enumerate(_files(self.action), start=1):
            step = f"upload_board_file_{number}"
            file_id = _mapped_id(self.context, "control_files", file_key, step=step)
            content = dummy_file(filename)
            response = self.send(
                "PUT",
                f"/api/boards/{self.board_id}/files/{file_id}/content",
                step,
                200,
                headers=UPLOAD_HEADERS,
                content=content,
            )
            body = _file_body(response, file_id=file_id, step=step)
            if body.get("state") != "ready" or body.get("actual_size") != len(content):
                raise SamplePhaseActionError("Board file upload did not finish ready", step=step)

    def attachment(self, kind: str, *, create: bool) -> None:
        content_key = _string(self.action.values, "content_key", step=self.action.key)
        file_key = _string(self.action.values, "file_key", step=self.action.key)
        content_id = _mapped_id(self.context, f"{kind}s", content_key, step=self.action.key)
        file_id = _mapped_id(self.context, "control_files", file_key, step=self.action.key)
        view = {"view": "draft"} if kind == "post" else None
        base = f"/api/boards/{self.board_id}/{kind}s/{content_id}"
        board = self.read(f"/api/boards/{self.board_id}", "read_attachment_board")
        current = self.read(base, f"read_attachment_{kind}", view)
        revisions = {
            "board_revision": _revision(board, "revision", step="read_attachment_board"),
            "content_revision": _revision(
                current, "post_revision" if kind == "post" else "revision",
                step=f"read_attachment_{kind}",
            ),
        }  # fmt: skip
        if create:
            response = self.send("POST", f"{base}/attachments", f"attach_{kind}_file", 200,
                                 json_body={"file_id": file_id, **revisions})  # fmt: skip
            body = _file_body(response, file_id=file_id, step=f"attach_{kind}_file")
            if body.get("state") != "ready":
                raise SamplePhaseActionError("Attached file is not ready", step=self.action.key)
        else:
            self._listed(base, file_id, view, listed=True)
            self.send("DELETE", f"{base}/attachments/{file_id}", f"detach_{kind}_file", 204,
                      json_body=revisions)  # fmt: skip
        self._listed(base, file_id, view, listed=create)
        if create:
            filename = _string(self.action.values, "filename", step=self.action.key)
            download = self.send("GET", f"{base}/attachments/{file_id}/content",
                                 f"download_{kind}_file", 200, params=view)  # fmt: skip
            issue = download_issue(download, filename)
            if issue is not None:
                raise SamplePhaseActionError(issue, step=f"download_{kind}_file")

    def _listed(
        self, base: str, file_id: str, view: Mapping[str, str] | None, *, listed: bool
    ) -> None:
        params = {**(view or {}), "limit": 25, "offset": 0}
        page = self.read(f"{base}/attachments", "list_attachments", params)
        rows = page.get("items")
        found = isinstance(rows, list) and any(
            isinstance(row, Mapping) and row.get("id") == file_id and row.get("state") == "ready"
            for row in rows
        )
        if not isinstance(rows, list) or found != listed:
            raise SamplePhaseActionError(
                "The attachment list differs from the planned end state", step="list_attachments"
            )


def execute_board_file_action(
    action: PhaseAction,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    operation = action.values.get("operation")
    if operation == "board_files_archive_purge":
        from operations.sample.controls.board_file_purge import execute_board_file_purge

        return execute_board_file_purge(action, context, on_substep=on_substep)
    run = _Run(action, context, on_substep)
    if operation == "board_file_reserve":
        run.reserve()
    elif operation == "board_file_upload":
        run.upload()
    elif operation in {"post_attachment_create", "post_attachment_delete"}:
        run.attachment("post", create=operation.endswith("create"))
    elif operation in {"event_attachment_create", "event_attachment_delete"}:
        run.attachment("event", create=operation.endswith("create"))
    else:
        raise SamplePhaseActionError("Unsupported Board file action", step=action.key)
    return _result(
        action,
        context,
        run.evidence,
        run.mappings,
        extra={"operation": operation},
    )


def verify_board_file_controls(
    admin: SampleClient,
    actions: tuple[PhaseAction, ...],
    mappings: Mapping[str, Any],
    *,
    actor_ids: Mapping[str, Any],
    admin_id: str,
) -> list[str]:
    """Owned files finish purged and detached; seeded attachments remain untouched."""
    issues: list[str] = []
    files = mappings.get("control_files")
    for action in actions:
        operation = action.values.get("operation")
        if operation not in {"post_attachment_delete", "event_attachment_delete"}:
            continue
        kind = "post" if operation == "post_attachment_delete" else "event"
        board_id = mappings.get("boards", {}).get(action.values.get("board_key"))
        content_id = mappings.get(f"{kind}s", {}).get(action.values.get("content_key"))
        file_id = files.get(action.values.get("file_key")) if isinstance(files, Mapping) else None
        if not all(isinstance(value, str) for value in (board_id, content_id, file_id)):
            issues.append("A Board file control mapping is missing")
            continue
        params = {"limit": 100, "offset": 0, **({"view": "draft"} if kind == "post" else {})}
        try:
            response = admin.request(
                "GET", f"/api/boards/{board_id}/{kind}s/{content_id}/attachments", params=params
            )
            rows = response.json().get("items") if response.status_code == 200 else None
        except (SampleClientError, ValueError, AttributeError):
            rows = None
        if not isinstance(rows, list):
            issues.append("Board file control final-state readback failed")
        elif any(isinstance(row, Mapping) and row.get("id") == file_id for row in rows):
            issues.append("A Board control file is still attached after its planned removal")
    for action in actions:
        if action.values.get("operation") != "board_files_archive_purge":
            continue
        from operations.sample.controls.board_file_purge import validate_board_file_state

        step = "verify_owned_board_file"
        try:
            source_actor = _string(action.values, "source_actor", step=step)
            bindings = {**actor_ids, "admin": admin_id}
            creator_id = _id(bindings, source_actor, label="file creator", step=step)
        except SamplePhaseActionError:
            issues.append("Owned Board file expected creator binding is missing or invalid")
            continue
        board_id = mappings.get("boards", {}).get(action.values.get("board_key"))
        for key, filename in _files(action):
            file_id = files.get(key) if isinstance(files, Mapping) else None
            if not isinstance(file_id, str) or not isinstance(board_id, str):
                issues.append("Owned Board file identity mapping is missing or invalid")
                continue
            path = f"/api/boards/{board_id}/files/{file_id}"
            try:
                response = admin.request("GET", path)
                body = response.json() if response.status_code == 200 else {}
                validate_board_file_state(
                    body,
                    file_id=file_id,
                    board_id=board_id,
                    filename=filename,
                    creator_id=creator_id,
                    state="purged",
                    deleted=True,
                    step=step,
                )
                if admin.request("GET", path + "/content").status_code != 404:
                    issues.append("Owned Board file final purge readback differs")
            except (SampleClientError, SamplePhaseActionError, ValueError, AttributeError):
                issues.append("Owned Board file final purge readback failed")
    return issues
