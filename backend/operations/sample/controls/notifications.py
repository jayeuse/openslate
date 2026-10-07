"""Recipient notification controls using notices from authored sample activity."""

from collections.abc import Mapping
from typing import Any, cast

from pydantic import ValidationError

from app.systems.access.users.schemas import AuthMeResponse
from operations.sample.actors import planned_access_level
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.notifications_verification import (
    _fail,
    _same_rows,
    _unread,
    _validate_rows,
)
from operations.sample.controls.notifications_verification import (
    verify_notification_controls as verify_notification_controls,
)
from operations.sample.controls.notifications_verification import (
    verify_notification_evidence as verify_notification_evidence,
)
from operations.sample.controls.platform_verification import validate_platform_page
from operations.sample.controls.reads import plan_read_controls
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    _id,
    _read_json,
    _request,
    _request_id,
    _result,
)
from operations.sample.phases.plan import plan_phases

CONTROL_ROUTES = frozenset(
    {
        ("GET", "/api/notifications"),
        ("GET", "/api/notifications/unread-count"),
        ("POST", "/api/notifications/{notification_id}/read"),
        ("POST", "/api/notifications/read-all"),
    }
)


def plan_notification_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    excluded = {key for row in plan_phases(dataset) for key in (row.actor_key, row.target_key)} | {
        plan_account_controls(dataset)[0].actor_key,
        plan_read_controls(dataset)[0].target_key,
    }
    modules = {module.key: module for module in dataset.organization.catalog.modules}
    eligible = []
    for person in dataset.organization.actors.people:
        if person.role != "member" or person.status != "active" or person.key in excluded:
            continue
        sources = {
            record.logical_id
            for record in dataset.records
            if record.assignee_key == person.key
            and planned_access_level(
                dataset.organization, person.key, record.actor_key, record.module_key
            )
            >= 1
            and any(
                field.type == "User"
                and record.data.get(dataset.field_ids[record.module_key][field.key])
                == f"@user:{person.key}"
                for field in modules[record.module_key].fields
            )
        }
        if len(sources) >= 2:
            eligible.append(person.key)
    if len(eligible) < 2:
        raise ValueError("Notification controls need two owned assignment recipients")
    actor, observer = sorted(eligible)[:2]
    return (
        PhaseAction(
            key="control:notifications",
            phase="reorganization",
            kind="platform_controls",
            actor_key=actor,
            target_key=actor,
            values={"operation": "review_notifications", "observer_key": observer},
            expected_status=200,
            expected_detail=None,
            expected_end_state={"unread_cleared": True, "other_recipient_unchanged": True},
        ),
    )


EVIDENCE_KEYS = tuple(
    "step actor_key actor_id method path expected_status status_code request_id".split()
)


def _bindings(
    action: PhaseAction, dataset: SampleDataset, context: PhaseExecutionContext
) -> tuple[str, str]:
    if action not in plan_notification_controls(dataset):
        _fail("Notification action differs from its owned plan", "notification_plan")
    observer = action.values.get("observer_key")
    if not isinstance(observer, str):
        _fail("Notification observer is invalid", "notification_actor")
    for key in (action.actor_key, observer):
        identifier = _id(context.user_ids, key, label="recipient", step="notification_actor")
        if (
            key == "admin"
            or identifier == context.user_ids.get("admin")
            or sum(value == identifier for value in context.user_ids.values()) != 1
        ):
            _fail("Notification recipient binding is not uniquely owned", "notification_actor")
    return action.actor_key, observer


class _Run:
    def __init__(
        self,
        action: PhaseAction,
        dataset: SampleDataset,
        context: PhaseExecutionContext,
        substep: PhaseSubstep | None,
    ):
        self.action, self.dataset, self.context, self.substep = action, dataset, context, substep
        self.primary, self.observer = _bindings(action, dataset, context)
        self.evidence: list[dict[str, object]] = []
        self.pages: dict[str, int] = {}

    def request(
        self, actor: str, method: str, path: str, step: str, params: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        response = _request(
            self.action,
            self.context,
            self.evidence,
            actor_key=actor,
            method=method,
            path=path,
            step=step,
            expected=200,
            on_substep=self.substep,
            params=params,
        )
        request_id = _request_id(response)
        if request_id is None:
            _fail("Notification request has no canonical identity", step)
        if method == "GET":
            self.evidence.append(
                {
                    "step": step,
                    "actor_key": actor,
                    "actor_id": self.context.user_ids[actor],
                    "method": method,
                    "path": path,
                    "expected_status": 200,
                    "status_code": 200,
                    "request_id": request_id,
                }
            )
        else:
            self.evidence[-1] = {key: self.evidence[-1][key] for key in EVIDENCE_KEYS}
        return _read_json(response, step=step)

    def identity(self, actor: str, step: str) -> None:
        try:
            identity = AuthMeResponse.model_validate(
                self.request(actor, "GET", "/api/auth/me", step)
            )
        except ValidationError:
            _fail("Notification recipient identity DTO is invalid", step)
        if (
            str(identity.id) != self.context.user_ids[actor]
            or identity.role != "member"
            or identity.status != "active"
            or identity.is_deleted
        ):
            _fail("Notification authenticated recipient differs", step)

    def count(self, actor: str, step: str) -> int:
        body = self.request(actor, "GET", "/api/notifications/unread-count", step)
        value = body.get("unread_count")
        if set(body) != {"unread_count"} or type(value) is not int or value < 0:
            _fail("Notification unread count is invalid", step)
        return value

    def listing(self, actor: str, step: str) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        expected_total = None
        for page_number in range(100):
            offset = len(output)
            body = self.request(
                actor,
                "GET",
                "/api/notifications",
                f"{step}_page_{offset}",
                {"limit": 25, "offset": offset},
            )
            rows = validate_platform_page(body, 25, step, offset=offset)
            total = body["pagination"]["total"]
            if expected_total is not None and total != expected_total:
                _fail("Notification total changed during bounded paging", step)
            expected_total = total
            output.extend(rows)
            if len(output) == total:
                self.pages[step] = page_number + 1
                return _validate_rows(output, self.dataset, self.context, actor, step)
            if not rows:
                _fail("Notification listing ended before its total", step)
        _fail("Notification listing exceeded the bounded page budget", step)


def execute_notification_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    run = _Run(action, dataset, context, on_substep)
    run.identity(run.primary, "primary_identity_before")
    run.identity(run.observer, "observer_identity_before")
    primary = run.listing(run.primary, "primary_before")
    before = run.count(run.primary, "primary_count_before")
    other = run.listing(run.observer, "observer_before")
    other_count = run.count(run.observer, "observer_count_before")
    if (
        before != _unread(primary)
        or other_count != _unread(other)
        or before < 2
        or {r["id"] for r in primary} & {r["id"] for r in other}
    ):
        _fail(
            "Notification recipient counts or privacy preconditions differ", "notification_before"
        )
    for actor, rows in ((run.primary, primary), (run.observer, other)):
        owned_sources = {
            context.runtime_mappings.get("records", {}).get(r.logical_id)
            for r in dataset.records
            if r.assignee_key == actor
        }
        if (
            len(
                {
                    row["subject_id"]
                    for row in rows
                    if row["kind"] == "record-assigned" and row["subject_id"] in owned_sources
                }
            )
            < 2
        ):
            _fail("No two real owned assignment notices are available", "notification_before")
    selected = next(row for row in primary if row["status"] == "unread")
    marked = run.request(
        run.primary, "POST", f"/api/notifications/{selected['id']}/read", "mark_one"
    )
    _validate_rows([marked], dataset, context, run.primary, "mark_one")
    if (
        marked["id"] != selected["id"]
        or marked["status"] != "read"
        or marked["read_at"] is None
        or not _same_rows([selected], [marked], all_read=True)
    ):
        _fail("Notification single read is unconfirmed", "mark_one")
    after_one = run.listing(run.primary, "primary_after_one")
    count_one = run.count(run.primary, "primary_count_after_one")
    if (
        count_one != before - 1
        or count_one != _unread(after_one)
        or not _same_rows(primary, after_one, marked=marked)
    ):
        _fail("Notification single-read readback differs", "primary_after_one")
    updated = run.request(run.primary, "POST", "/api/notifications/read-all", "mark_all")
    if (
        set(updated) != {"updated_count"}
        or type(updated["updated_count"]) is not int
        or updated["updated_count"] != count_one
    ):
        _fail("Notification read-all updated count differs", "mark_all")
    result = _result(
        action,
        context,
        run.evidence,
        [],
        extra={
            "unread_before": before,
            "unread_after_one": count_one,
            "notification_before": {"primary": primary, "observer": other},
            "observer_unread_before": other_count,
            "notification_after_one": after_one,
            "single_read_notice": marked,
            "notification_pages": run.pages,
        },
    )
    readback = verify_notification_controls(dataset, context, action, result, on_substep=on_substep)
    run.evidence.extend(cast(list[dict[str, object]], readback.pop("request_evidence")))
    run.pages.update(cast(dict[str, int], readback.pop("notification_pages")))
    result.update(
        unread_after_all=0,
        unread_cleared=True,
        other_recipient_unchanged=True,
        notification_readback=readback,
    )
    return result
