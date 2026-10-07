"""Recipient readback and historical receipts for the notification control boundary."""

from collections.abc import Mapping
from datetime import timedelta
from typing import Any, NoReturn

from pydantic import TypeAdapter, ValidationError

from app.systems.platform.scheduling.notification_router import NotificationItem
from operations.sample.blueprint import SampleDataset
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
)


def _fail(message: str, step: str) -> NoReturn:
    raise SamplePhaseActionError(message, step=step)


def _validate_rows(
    rows: object, dataset: SampleDataset, context: PhaseExecutionContext, actor: str, step: str
) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        _fail("Notification list is invalid", step)
    try:
        parsed = TypeAdapter(list[NotificationItem]).validate_python(rows)
    except ValidationError:
        _fail("Notification DTO is invalid", step)
    owned = context.runtime_mappings
    record_ids = {
        value
        for bucket in ("records", "control_records", "platform_records")
        for value in owned.get(bucket, {}).values()
    }
    seed_records = {
        identifier: next((r for r in dataset.records if r.logical_id == key), None)
        for key, identifier in owned.get("records", {}).items()
    }
    identifiers = set()
    for row, model in zip(rows, parsed, strict=True):
        if set(row) != set(model.model_dump()) or row["id"] in identifiers:
            _fail("Notification rows are duplicated or contain private fields", step)
        identifiers.add(row["id"])
        if (row["status"] == "read") != (row["read_at"] is not None):
            _fail("Notification read status is inconsistent", step)
        for value in (model.created_at, model.read_at, model.scheduled_for):
            if value is not None and value.utcoffset() != timedelta(0):
                _fail("Notification date is not UTC", step)
        kind, subject = row["kind"], row["subject_id"]
        if kind == "record-assigned":
            source = seed_records.get(subject)
            if subject not in record_ids or (
                source is not None and row["module_id"] != context.module_ids.get(source.module_key)
            ):
                _fail("Notification record subject is not owned", step)
        elif kind == "access-changed":
            if subject != context.user_ids[actor]:
                _fail("Notification recipient subject differs", step)
        elif kind in {"post-publish", "event-reminder"}:
            bucket, key = ("posts", "post_id") if kind == "post-publish" else ("events", "event_id")
            if (
                subject not in owned.get(bucket, {}).values()
                or subject != row[key]
                or row["board_id"] not in owned.get("boards", {}).values()
            ):
                _fail("Notification Board subject is not owned", step)
        else:
            _fail("Notification source has no owned control reference", step)
    return rows


def _unread(rows: list[dict[str, Any]]) -> int:
    return sum(row["status"] == "unread" for row in rows)


def _same_rows(
    before: list[dict[str, Any]],
    after: list[dict[str, Any]],
    *,
    marked: Mapping[str, Any] | None = None,
    all_read: bool = False,
) -> bool:
    current = {row["id"]: row for row in after}
    if set(current) != {row["id"] for row in before}:
        return False
    for original in before:
        row = current[original["id"]]
        expected = marked if marked is not None and original["id"] == marked["id"] else original
        if any(row[key] != expected[key] for key in original if key not in {"status", "read_at"}):
            return False
        if all_read and expected["status"] == "unread":
            if row["status"] != "read" or row["read_at"] is None:
                return False
        elif row["status"] != expected["status"] or row["read_at"] != expected["read_at"]:
            return False
    return True


def verify_notification_controls(
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    action: PhaseAction,
    result: Mapping[str, Any],
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    from operations.sample.controls.notifications import _Run

    run = _Run(action, dataset, context, on_substep)
    run.identity(run.primary, "primary_identity_verify")
    run.identity(run.observer, "observer_identity_verify")
    primary = run.listing(run.primary, "primary_verify")
    count = run.count(run.primary, "primary_count_verify")
    other = run.listing(run.observer, "observer_verify")
    other_count = run.count(run.observer, "observer_count_verify")
    before = result.get("notification_before")
    if not isinstance(before, Mapping):
        _fail("Notification pre-read receipts are missing", "notification_verify")
    if (
        count != 0
        or not _same_rows(
            before["primary"], primary, marked=result["single_read_notice"], all_read=True
        )
        or not _same_rows(before["observer"], other)
        or other_count != result["observer_unread_before"]
        or other_count != _unread(other)
    ):
        _fail("Notification independent recipient readback differs", "notification_verify")
    return {
        "verification_boundary": "immediate-recipient-readback",
        "primary": primary,
        "observer": other,
        "unread_count": count,
        "observer_unread_count": other_count,
        "request_evidence": run.evidence,
        "notification_pages": run.pages,
    }


def verify_notification_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.controls.notifications import EVIDENCE_KEYS, _bindings

    start = len(issues)
    try:
        actors = manifest["actor_ids"]
        context = PhaseExecutionContext(
            clients={},
            user_ids={**actors, "admin": admin_id},
            group_ids={},
            department_ids={},
            module_ids=manifest["mappings"].get("modules", {}),
            field_ids={},
            mappings=manifest["mappings"],
            admin_password="",
        )
        primary, observer = _bindings(action, dataset, context)
        before, after_one, readback = (
            result["notification_before"],
            result["notification_after_one"],
            result["notification_readback"],
        )
        p = _validate_rows(before["primary"], dataset, context, primary, "notification_receipt")
        o = _validate_rows(before["observer"], dataset, context, observer, "notification_receipt")
        middle = _validate_rows(after_one, dataset, context, primary, "notification_receipt")
        final = _validate_rows(
            readback["primary"], dataset, context, primary, "notification_receipt"
        )
        other = _validate_rows(
            readback["observer"], dataset, context, observer, "notification_receipt"
        )
        if (
            readback["verification_boundary"] != "immediate-recipient-readback"
            or {row["id"] for row in p} & {row["id"] for row in o}
            or result["unread_before"] != _unread(p)
            or result["unread_before"] < 2
            or result["unread_after_one"] != _unread(middle)
            or result["unread_after_one"] != result["unread_before"] - 1
            or result["unread_after_all"] != readback["unread_count"]
            or type(result["unread_after_all"]) is not int
            or result["unread_after_all"] != 0
            or not _same_rows(p, middle, marked=result["single_read_notice"])
            or not _same_rows(p, final, marked=result["single_read_notice"], all_read=True)
            or not _same_rows(o, other)
            or readback["observer_unread_count"] != _unread(other)
        ):
            raise ValueError
        expected: list[tuple[str, str, str, str]] = []
        pages = result["notification_pages"]

        def identity(actor: str, step: str) -> None:
            expected.append((step, actor, "GET", "/api/auth/me"))

        def listing(actor: str, step: str, rows: list[dict[str, Any]], count_step: str) -> None:
            total_pages = max(1, (len(rows) + 24) // 25)
            if type(pages[step]) is not int or pages[step] != total_pages or total_pages > 100:
                raise ValueError
            for index in range(total_pages):
                expected.append((f"{step}_page_{index * 25}", actor, "GET", "/api/notifications"))
            expected.append((count_step, actor, "GET", "/api/notifications/unread-count"))

        identity(primary, "primary_identity_before")
        identity(observer, "observer_identity_before")
        listing(primary, "primary_before", p, "primary_count_before")
        listing(observer, "observer_before", o, "observer_count_before")
        expected.append(
            (
                "mark_one",
                primary,
                "POST",
                f"/api/notifications/{result['single_read_notice']['id']}/read",
            )
        )
        listing(primary, "primary_after_one", middle, "primary_count_after_one")
        expected.append(("mark_all", primary, "POST", "/api/notifications/read-all"))
        identity(primary, "primary_identity_verify")
        identity(observer, "observer_identity_verify")
        listing(primary, "primary_verify", final, "primary_count_verify")
        listing(observer, "observer_verify", other, "observer_count_verify")
        evidence = result["request_evidence"]
        local_ids: set[str] = set()
        if len(evidence) != len(expected):
            raise ValueError
        for row, contract in zip(evidence, expected, strict=True):
            request_id = _id(row, "request_id", label="request", step="notification_receipt")
            if (
                set(row) != set(EVIDENCE_KEYS)
                or tuple(row[key] for key in ("step", "actor_key", "method", "path")) != contract
                or row["actor_id"] != context.user_ids[contract[1]]
                or type(row["status_code"]) is not int
                or row["expected_status"] != row["status_code"]
                or row["status_code"] != 200
                or request_id in local_ids | seen_request_ids
            ):
                raise ValueError
            local_ids.add(request_id)
        seen_request_ids.update(local_ids)
    except (KeyError, TypeError, ValueError, SamplePhaseActionError):
        issues.append("Notification historical control receipts differ from the owned contract")
    if len(issues) == start:
        observed["control_requests_verified"] += len(expected)
        observed["notification_receipt_actions_verified"] = (
            observed.get("notification_receipt_actions_verified", 0) + 1
        )
