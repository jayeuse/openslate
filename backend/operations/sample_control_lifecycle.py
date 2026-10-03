"""HTTP execution and binding validation for disposable structural lifecycle."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Any, cast

import httpx
from pydantic import ValidationError

from app.systems.sandbox.designs.schemas import SandboxBindingsResponse, SandboxDocument
from app.systems.sandbox.designs.service import canonical_document
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleClosePreviewResponse,
    LifecycleMutationResponse,
)
from operations.sample_blueprint import SampleDataset
from operations.sample_control_sandbox import (
    OPERATIONS,
    VERSION_KEY,
    fixture_document,
    fixture_values,
    plan_lifecycle_controls,
)
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _result,
)
from operations.sample_phase_design_common import (
    _canonical_document,
    _publish_and_map_version,
    _save_document,
)
from operations.sample_phase_outputs import expected_lifecycle_document

BindingRows = dict[tuple[str, str | None, str], dict[str, Any]]


def parse_bindings(
    content: bytes, document: Mapping[str, Any], revision: int, *, step: str
) -> BindingRows:
    try:
        parsed = SandboxBindingsResponse.model_validate_json(content)
    except ValidationError:
        raise SamplePhaseActionError(
            "Sandbox lifecycle binding response was invalid", step=step
        ) from None
    identities = {
        (kind, None, item["id"])
        for kind, items in (
            ("department", document["design"]["departments"]),
            ("module", document["design"]["modules"]),
            ("relationship", document["design"]["relationships"]),
            ("trigger", document["triggers"]),
        )
        for item in items
    }
    identities.update(
        ("field", module["id"], field["id"])
        for module in document["design"]["modules"]
        for field in module["fields"]
    )
    rows = parsed.model_dump(mode="json")["items"]
    indexed = {(row["kind"], row["parent_sandbox_id"], row["sandbox_id"]): row for row in rows}
    if (
        parsed.document_revision != revision
        or len(indexed) != len(rows)
        or not indexed.keys() <= identities
    ):
        raise SamplePhaseActionError(
            "Sandbox lifecycle bindings were stale or ambiguous", step=step
        )
    return indexed


def fixture_identities(dataset: SampleDataset) -> dict[str, tuple[str, str | None, str]]:
    values = fixture_values(dataset)
    module = cast(str, values["module_sandbox_id"])
    return {
        "department": ("department", None, cast(str, values["department_sandbox_id"])),
        "module": ("module", None, module),
        "title_field": ("field", module, cast(str, values["title_sandbox_id"])),
        "field": ("field", module, cast(str, values["field_sandbox_id"])),
    }


class _LifecycleJourney:
    """One planned control using the existing authenticated request transport."""

    def __init__(
        self,
        action: PhaseAction,
        dataset: SampleDataset,
        context: PhaseExecutionContext,
        on_substep: PhaseSubstep | None,
    ):
        self.action, self.dataset, self.context, self.on_substep = (
            action,
            dataset,
            context,
            on_substep,
        )
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []

    def request(
        self,
        path: str,
        step: str,
        *,
        method: str = "GET",
        expected: int = 200,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        return _request(
            self.action,
            self.context,
            self.evidence,
            actor_key=self.action.actor_key,
            method=method,
            path=path,
            step=step,
            expected=expected,
            on_substep=self.on_substep,
            json_body=body,
            params=params,
        )

    def read(
        self, path: str, step: str, *, params: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        return _read_json(self.request(path, step, params=params), step=step)

    @property
    def ids(self) -> dict[str, str]:
        return self.context.runtime_mappings["sandbox_lifecycle"]

    def document_bindings(
        self,
        document: dict[str, Any],
        step: str,
        binding_step: str,
        previous_revision: int | None = None,
    ) -> tuple[int, BindingRows]:
        current = self.read("/api/sandbox/document", step)
        revision = current.get("revision")
        if (
            type(revision) is not int
            or revision < 1
            or (previous_revision is not None and revision != previous_revision + 1)
            or _canonical_document(current.get("document"), step=step) != document
        ):
            raise SamplePhaseActionError(
                "Sandbox lifecycle document or revision did not match", step=step
            )
        response = self.request("/api/sandbox/bindings", binding_step)
        return revision, parse_bindings(response.content, document, revision, step=binding_step)

    def state(
        self, document: dict[str, Any], suffix: str, previous_revision: int | None = None
    ) -> int:
        revision, bindings = self.document_bindings(
            document, f"read_{suffix}", f"bindings_{suffix}", previous_revision
        )
        values, design = fixture_values(self.dataset), document["design"]
        department = next(
            (row for row in design["departments"] if row["id"] == values["department_sandbox_id"]),
            None,
        )
        module = next(
            (row for row in design["modules"] if row["id"] == values["module_sandbox_id"]), None
        )
        for key, identity in fixture_identities(self.dataset).items():
            target = (
                department
                if key == "department"
                else module
                if key == "module"
                else next((row for row in module["fields"] if row["id"] == identity[2]), None)
                if module
                else None
            )
            deleted = bool(
                target
                and (
                    target["closed"]
                    or (module and module["closed"] and identity[0] == "field")
                    or (department and department["closed"])
                )
            )
            row = bindings.get(identity)
            if (target is None and row is not None) or (
                target is not None
                and (
                    row is None
                    or row["live_id"] != self.ids[key]
                    or row["is_deleted"] is not deleted
                )
            ):
                raise SamplePhaseActionError(
                    "Sandbox lifecycle binding state did not match", step=f"bindings_{suffix}"
                )
            step = f"live_{key}_{suffix}"
            response = self.request(
                f"/api/{identity[0]}s/{self.ids[key]}",
                step,
                expected=404 if target is None else 200,
            )
            if target is not None:
                live = _read_json(response, step=step)
                name_key = "name" if identity[0] == "field" else identity[0] + "_name"
                if (
                    live.get("id") != self.ids[key]
                    or live.get("is_deleted") is not deleted
                    or live.get(name_key) != target["name"]
                    or (identity[0] == "field" and live.get("module_id") != self.ids["module"])
                    or (key == "module" and live.get("department_id") != self.ids["department"])
                ):
                    raise SamplePhaseActionError(
                        "Sandbox lifecycle live readback differed", step=step
                    )
        step = f"board_{suffix}"
        response = self.request(
            f"/api/boards/{self.ids['board']}", step, expected=404 if department is None else 200
        )
        if department is not None:
            board = _read_json(response, step=step)
            if (
                board.get("id") != self.ids["board"]
                or board.get("department_id") != self.ids["department"]
                or board.get("scope") != "department"
                or board.get("name") != department["name"]
                or board.get("status") != ("archived" if department["closed"] else "active")
            ):
                raise SamplePhaseActionError(
                    "Sandbox lifecycle Department Board state differed", step=step
                )
        return revision

    def prepare(self) -> None:
        step = "read_before_lifecycle_fixture"
        current = self.read("/api/sandbox/document", step)
        revision = current.get("revision")
        if (
            type(revision) is not int
            or revision < 1
            or _canonical_document(current.get("document"), step=step)
            != expected_lifecycle_document(self.dataset, OPERATIONS[0])
        ):
            raise SamplePhaseActionError(
                "Lifecycle fixture would overwrite another draft", step=step
            )
        document = fixture_document(self.dataset)
        revision = _save_document(
            self.action,
            self.context,
            self.evidence,
            document,
            revision,
            step="save_lifecycle_fixture",
            on_substep=self.on_substep,
        )
        _publish_and_map_version(
            replace(self.action, expected_status=201),
            self.context,
            self.evidence,
            self.mappings,
            revision=revision,
            version_key=VERSION_KEY,
            preview_step="preview_lifecycle_fixture",
            publish_step="publish_lifecycle_fixture",
            on_substep=self.on_substep,
        )
        version_id = self.context.runtime_mappings["sandbox_versions"][VERSION_KEY]
        step = "read_lifecycle_snapshot"
        snapshot = self.read(f"/api/sandbox/versions/{version_id}", step)
        if (
            snapshot.get("id") != version_id
            or snapshot.get("kind") != "published"
            or snapshot.get("isDeleted") is not False
            or _canonical_document(snapshot.get("document"), step=step) != document
            or snapshot.get("contentHash")
            != canonical_document(SandboxDocument.model_validate(document))[1]
        ):
            raise SamplePhaseActionError("Lifecycle fixture snapshot differed", step=step)
        _, bindings = self.document_bindings(
            document, "read_published_lifecycle_fixture", "read_fixture_bindings"
        )
        identities = fixture_identities(self.dataset)
        selected = {key: bindings.get(identity) for key, identity in identities.items()}
        live_ids = {row["live_id"] for row in selected.values() if row is not None}
        if (
            len(live_ids) != 4
            or any(row is None or row["is_deleted"] is not False for row in selected.values())
            or any(
                row["live_id"] in live_ids
                for identity, row in bindings.items()
                if identity not in identities.values()
            )
        ):
            raise SamplePhaseActionError(
                "Lifecycle fixture bindings were missing or aliased", step="read_fixture_bindings"
            )
        for key, row in selected.items():
            assert row is not None
            self.map(key, row["live_id"])
        step = "read_lifecycle_department_board"
        page = self.read(
            "/api/boards",
            step,
            params={
                "scope": "department",
                "department_id": self.ids["department"],
                "status": "all",
                "limit": 100,
                "offset": 0,
            },
        )
        rows = page.get("items")
        metadata = page.get("pagination")
        if (
            not isinstance(rows, list)
            or len(rows) != 1
            or not isinstance(rows[0], dict)
            or not isinstance(metadata, dict)
            or any(
                type(metadata.get(key)) is not int for key in ("limit", "offset", "count", "total")
            )
            or metadata.get("has_more") is not False
            or page.get("pagination")
            != {"limit": 100, "offset": 0, "count": 1, "total": 1, "has_more": False}
        ):
            raise SamplePhaseActionError(
                "Lifecycle Department Board collection differed", step=step
            )
        self.map("board", _id(rows[0], "id", label="Department Board", step=step))
        self.state(document, "prepared_lifecycle_fixture")

    def map(self, key: str, live_id: str) -> None:
        _record_mapping(
            self.context,
            self.context.clients[self.action.actor_key],
            "sandbox_lifecycle",
            key,
            live_id,
            self.mappings,
        )

    def check_impact(self, impact: Any, kind: str, verb: str, live_id: str, step: str) -> None:
        if (
            impact.target_type.value != kind
            or str(impact.target_id) != live_id
            or impact.operation.value != verb
            or str(impact.actor_id) != self.context.user_ids[self.action.actor_key]
            or impact.blockers
            or impact.external_impacts
            or impact.key_strips
        ):
            raise SamplePhaseActionError(
                "Lifecycle impact did not match the disposable target", step=step
            )

    def change(self, kind: str, verb: str, step: str) -> None:
        live_id = self.ids[kind]
        path = f"/api/{kind}s/{live_id}/{verb}"
        payload: dict[str, Any] = {"confirmed": True}
        if verb != "reopen":
            preview_step = f"preview_{step}"
            response = self.request(path + "/preview", preview_step, method="POST")
            try:
                preview = LifecycleClosePreviewResponse.model_validate_json(response.content)
            except ValidationError:
                raise SamplePhaseActionError(
                    "Lifecycle preview was invalid", step=preview_step
                ) from None
            self.check_impact(preview.impact, kind, verb, live_id, preview_step)
            if not preview.token or not preview.confirmation_name:
                raise SamplePhaseActionError(
                    "Lifecycle preview had no name confirmation", step=preview_step
                )
            payload = {
                "token": preview.token,
                "confirmation_name": preview.confirmation_name,
                "password": self.context.admin_password,
            }
        response = self.request(path, step, method="POST", body=payload)
        try:
            mutation = LifecycleMutationResponse.model_validate_json(response.content)
        except ValidationError:
            raise SamplePhaseActionError(
                "Lifecycle mutation response was invalid", step=step
            ) from None
        self.check_impact(mutation.impact, kind, verb, live_id, step)
        if str(mutation.operation_id) != _request_id(response):
            raise SamplePhaseActionError(
                "Lifecycle operation ID did not match its request", step=step
            )


def lifecycle_request_contract(
    operation: str, ids: Mapping[str, str]
) -> list[tuple[str, str, str, int]]:
    if operation == OPERATIONS[0]:
        return [
            ("save_lifecycle_fixture", "PUT", "/api/sandbox/document", 200),
            ("preview_lifecycle_fixture", "POST", "/api/sandbox/publication-previews", 200),
            ("publish_lifecycle_fixture", "POST", "/api/sandbox/publications", 201),
        ]
    verb, kind = operation.split("_")
    path = f"/api/{kind}s/{ids[kind]}"
    if verb == "reopen":
        return [(operation, "POST", path + "/reopen", 200)]
    steps = []
    if verb == "purge":
        steps.extend(
            [
                (f"preview_reclose_{kind}", "POST", path + "/close/preview", 200),
                (f"reclose_{kind}", "POST", path + "/close", 200),
            ]
        )
    return steps + [
        (f"preview_{operation}", "POST", path + f"/{verb}/preview", 200),
        (operation, "POST", path + f"/{verb}", 200),
    ]


def execute_lifecycle_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_lifecycle_controls(dataset):
        raise SamplePhaseActionError(
            "Lifecycle control differed from its pack plan", step=action.key
        )
    run = _LifecycleJourney(action, dataset, context, on_substep)
    operation = cast(str, action.values["operation"])
    if operation == OPERATIONS[0]:
        run.prepare()
        target = "module"
    else:
        verb, target = operation.split("_")
        revision = run.state(expected_lifecycle_document(dataset, operation), f"before_{operation}")
        if verb == "purge":
            run.change(target, "close", f"reclose_{target}")
            closed = expected_lifecycle_document(dataset, f"close_{target}", after=True)
            revision = run.state(closed, f"after_reclose_{target}", revision)
        run.change(target, verb, operation)
        run.state(
            expected_lifecycle_document(dataset, operation, after=True),
            f"after_{operation}",
            revision,
        )
    evidence = [
        {
            key: row[key]
            for key in (
                "step",
                "actor_key",
                "actor_id",
                "method",
                "path",
                "expected_status",
                "status_code",
                "request_id",
            )
        }
        for row in run.evidence
    ]
    return _result(
        action,
        context,
        evidence,
        run.mappings,
        extra={**action.expected_end_state, "target_id": run.ids[target]},
    )
