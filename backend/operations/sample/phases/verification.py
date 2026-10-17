"""Read-only verification for planned sample-data lifecycle phases."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, cast

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.expectations import read_phase_plan
from operations.sample.phases.plan import phase_expected_projection
from operations.sample.phases.security_verification import _verify_session_security_event
from operations.sample.phases.verification_plan import (
    _OPENVIEW,
    _actor_id,
    _mapping,
    _mappings,
    _person_id,
    _rules,
    _Step,
    _uuid,
)
from operations.sample.verification.core import SampleVerificationError, list_all_rows


def _list_phase_results(
    manifest: Mapping[str, Any], actions: tuple[PhaseAction, ...], issues: list[str]
) -> list[Mapping[str, Any]]:
    raw = manifest.get("phase_results")
    if not isinstance(raw, list) or any(not isinstance(item, Mapping) for item in raw):
        issues.append("phase result journal is missing or invalid")
        return []
    results = [item for item in raw if isinstance(item, Mapping)]
    if [item.get("action_key") for item in results] != [action.key for action in actions]:
        issues.append("phase result journal does not match the planned action order")
    return results


def _audit_rows(
    client: SampleClient, request_id: str, issues: list[str]
) -> list[Mapping[str, Any]]:
    try:
        return list_all_rows(client, "/api/audit-logs", params={"request_id": request_id})
    except (SampleVerificationError, SampleClientError):
        issues.append("phase request audit readback failed")
        return []


def _request_matches(
    client: SampleClient,
    action: PhaseAction,
    result: Mapping[str, Any],
    evidence: Mapping[str, Any],
    rule: _Step,
    manifest: Mapping[str, Any],
    admin_id: str,
    audit_seen: set[str],
    document_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> str | None:
    valid = True
    step = evidence.get("step")
    if not isinstance(step, str):
        issues.append("phase request descriptor has no step key")
        return None
    method, path = evidence.get("method"), evidence.get("path")
    expected_path = rule.path
    session_id: str | None = None
    if rule.dynamic_session and isinstance(path, str):
        suffix = path.removeprefix(rule.path)
        session_id = _uuid(suffix)
        if session_id is None:
            expected_path = ""
            valid = False
        else:
            expected_path = f"{rule.path}{session_id}"
            planned = result.get("session_id")
            if _uuid(planned) != session_id:
                issues.append("ended session mapping differs from its recorded request")
                valid = False
    if method != rule.method or path != expected_path:
        issues.append("phase request route differs from the recorded action")
        valid = False
    request_actor = rule.actor_key or action.actor_key
    expected_actor = _actor_id(manifest, admin_id, request_actor)
    if (
        expected_actor is None
        or evidence.get("actor_key") != request_actor
        or _uuid(evidence.get("actor_id")) != expected_actor
    ):
        issues.append("phase request actor differs from the planned actor")
        valid = False
    status, expected_status = evidence.get("status_code"), evidence.get("expected_status")
    if (
        type(status) is not int
        or status != rule.status
        or type(expected_status) is not int
        or expected_status != rule.status
    ):
        issues.append("phase request status differs from its planned result")
        valid = False

    write = rule.method in {"POST", "PUT", "PATCH", "DELETE"}
    if not write:
        issues.append("phase request evidence contains a read request")
        return session_id
    request_id = _uuid(evidence.get("request_id"))
    if request_id is None:
        issues.append("phase mutation request has no valid request ID")
        return session_id
    if request_id in audit_seen:
        issues.append("phase request journal reuses a request ID")
        return session_id
    audit_seen.add(request_id)
    rows = _audit_rows(client, request_id, issues)
    observed["phase_audit_rows"] += len(rows)

    if rule.audit_rows == 0:
        if rows:
            issues.append("a no-audit phase request unexpectedly created application audit rows")
            valid = False
        if (
            type(evidence.get("expected_audit_rows")) is not int
            or evidence.get("expected_audit_rows") != 0
            or evidence.get("primary_entity_type") != rule.entity
            or evidence.get("primary_action") != rule.action
        ):
            issues.append("phase request audit descriptor differs from the planned no-audit route")
            valid = False
        if rule.entity_id is None:
            if evidence.get("primary_entity_id") is not None:
                issues.append("phase no-audit descriptor claims an unexpected entity ID")
                valid = False
        elif _uuid(evidence.get("primary_entity_id")) != rule.entity_id:
            issues.append("phase request audit descriptor points to another no-audit target")
            valid = False
        related = evidence.get("related_entity_types")
        if not isinstance(related, list) or related:
            issues.append("phase no-audit descriptor claims related mutation rows")
            valid = False
        return session_id

    if (
        evidence.get("primary_entity_type") != rule.entity
        or type(evidence.get("expected_audit_rows")) is not int
        or evidence.get("expected_audit_rows") != rule.audit_rows
        or evidence.get("primary_action") != rule.action
    ):
        issues.append("phase mutation audit descriptor differs from its planned route")
        valid = False
    related = evidence.get("related_entity_types")
    if not isinstance(related, list) or tuple(related) != rule.related:
        issues.append("phase mutation related-audit descriptor differs from its planned route")
        valid = False
    descriptor_id = evidence.get("primary_entity_id")
    expected_id = session_id if rule.dynamic_session else rule.entity_id
    if rule.entity in {"sandbox_documents", "memberships"}:
        # Neither row ID is visible to the client; the audit row identifies it.
        if descriptor_id is not None:
            issues.append("phase document descriptor claims an unavailable row ID")
            valid = False
    elif rule.entity is not None and expected_id is None:
        issues.append("planned phase primary entity mapping is missing")
        valid = False
    elif expected_id is not None and _uuid(descriptor_id) != expected_id:
        issues.append("phase mutation primary ID differs from its planned target")
        valid = False

    if any(
        _uuid(row.get("request_id")) != request_id
        or row.get("performed_by") != expected_actor
        or row.get("request_method") != rule.method
        or row.get("request_path") != expected_path
        for row in rows
    ):
        issues.append("phase audit rows have inconsistent actor or request attribution")
        valid = False
    primary = [
        row
        for row in rows
        if row.get("entity_type") == rule.entity and row.get("action") == rule.action
    ]
    if len(primary) != 1:
        issues.append("phase mutation is missing its unique planned primary audit")
        valid = False
    else:
        entity_id = primary[0].get("entity_id")
        if expected_id is not None and _uuid(entity_id) != expected_id:
            issues.append("phase primary audit points to another entity")
            valid = False
        if rule.entity == "memberships":
            # The request's one membership update must be the role change itself.
            before, after = primary[0].get("before"), primary[0].get("after")
            if (
                not isinstance(before, Mapping)
                or not isinstance(after, Mapping)
                or after.get("role") not in {"admin", "member", "guest"}
                or before.get("role") == after.get("role")
            ):
                issues.append("phase membership audit is not the planned role change")
                valid = False
        if rule.entity == "sandbox_documents":
            canonical = _uuid(entity_id)
            if canonical is None:
                issues.append("phase document primary audit ID is invalid")
                valid = False
            else:
                document_ids.add(canonical)
                if len(document_ids) > 1:
                    issues.append("phase document audits refer to different draft documents")
                    valid = False
    for row in rows:
        if _uuid(row.get("entity_id")) is None:
            issues.append("phase audit row has an invalid entity ID")
            valid = False
    if valid:
        observed["phase_primary_audits"] += 1
    return session_id


def _object(
    client: SampleClient, path: str, issues: list[str], *, expected_status: int = 200
) -> Mapping[str, Any] | None:
    try:
        response = client.request("GET", path)
    except SampleClientError:
        issues.append("phase final-state readback failed")
        return None
    if response.status_code != expected_status:
        issues.append("phase final-state readback differs from the planned state")
        return None
    if expected_status == 404:
        return None
    try:
        body = response.json()
    except ValueError:
        issues.append("phase final-state readback returned invalid JSON")
        return None
    if not isinstance(body, Mapping):
        issues.append("phase final-state readback returned an invalid object")
        return None
    return body


def _list(
    client: SampleClient, path: str, issues: list[str], *, params: Mapping[str, Any] | None = None
) -> list[Mapping[str, Any]]:
    try:
        return list_all_rows(client, path, params=params)
    except (SampleVerificationError, SampleClientError):
        issues.append("phase final-state list readback failed")
        return []


def _verify_final_state(
    client: SampleClient,
    actions: tuple[PhaseAction, ...],
    manifest: Mapping[str, Any],
    mappings: Mapping[str, Mapping[str, str]],
    ended_sessions: Sequence[tuple[str, str]],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    try:
        projection = cast(Mapping[str, Any], phase_expected_projection(actions))
    except (KeyError, TypeError, ValueError):
        issues.append("phase plan cannot produce final-state expectations")
        return
    for logical_id, state in projection["boards"].items():
        if not isinstance(state, Mapping):
            continue
        purge_target = state.get("status") == "purged"
        target_map = (
            "phase_boards"
            if purge_target
            or any(
                item.target_key == logical_id and item.kind == "board_create_purge_target"
                for item in actions
            )
            else "boards"
        )
        board_id = _mapping(mappings, target_map, str(logical_id))
        if board_id is None:
            issues.append("planned Board mapping is missing")
            continue
        row = _object(
            client, f"/api/boards/{board_id}", issues, expected_status=404 if purge_target else 200
        )
        if purge_target:
            if row is None:
                observed["phase_state_checks"] += 1
            continue
        if row is not None:
            if (
                row.get("id") != board_id
                or row.get("scope") != "project"
                or row.get("status") != state.get("status")
            ):
                issues.append("project Board did not reach its planned final state")
            else:
                observed["phase_state_checks"] += 1

    for action in actions:
        if action.kind != "openview_restore":
            continue
        resource = str(action.values.get("resource_kind", ""))
        endpoint, entity = _OPENVIEW.get(resource, ("", ""))
        item_id = _mapping(mappings, endpoint, action.target_key) if endpoint else None
        if item_id is None:
            issues.append("planned OpenView mapping is missing")
            continue
        row = _object(client, f"/api/{endpoint}/{item_id}", issues)
        if row is None:
            continue
        if row.get("id") != item_id or row.get("is_deleted") is not False or not entity:
            issues.append("restored OpenView item has the wrong kind or current state")
        elif resource == "view" and row.get("is_default") is not False:
            issues.append("restored saved view is still the module default")
        else:
            observed["phase_state_checks"] += 1

    for action in actions:
        if action.kind not in {"disable_user", "restore_disabled_user"}:
            continue
        user_id = _person_id(manifest, mappings, action.target_key)
        if user_id is None:
            issues.append("disabled person's user mapping is missing")
            continue
        if not _list(client, f"/api/users/{user_id}/sessions", issues):
            observed["phase_state_checks"] += 1
        else:
            issues.append("disabled person's sessions were not fully revoked")
        break
    for user_id, session_id in ended_sessions:
        issue_count = len(issues)
        sessions = _list(client, f"/api/users/{user_id}/sessions", issues)
        if len(issues) != issue_count:
            continue
        if all(str(item.get("id")) != session_id for item in sessions):
            observed["phase_state_checks"] += 1
        else:
            issues.append("explicitly ended session remains active")

    module_action = next(
        (
            item
            for item in reversed(actions)
            if item.kind in {"sandbox_reopen_empty_publish", "sandbox_restore_publish"}
        ),
        None,
    )
    module_key = str(module_action.values.get("module_key", "")) if module_action else ""
    if not module_key:
        edit = next((item for item in actions if item.kind == "sandbox_edit_publish"), None)
        module_key = str(edit.values.get("new_module_key", "")) if edit else ""
    if module_key and projection["design"].get("new_module_closed") is False:
        module_id = _mapping(mappings, "modules", module_key)
        if module_id is None:
            issues.append("newly added module mapping is missing")
        else:
            module = _object(client, f"/api/modules/{module_id}", issues)
            if (
                module is not None
                and module.get("id") == module_id
                and module.get("is_deleted") is False
            ):
                records = _list(client, "/api/records", issues, params={"module_id": module_id})
                if records:
                    issues.append("reopened module contains records")
                else:
                    observed["phase_state_checks"] += 1
            elif module is not None:
                issues.append("newly added module is not reopened")


def verify_phases(
    client: SampleClient,
    *,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Verify phase readbacks and per-request audit attribution without writes."""
    del dataset
    counts = {
        "phase_actions": 0,
        "phase_requests": 0,
        "phase_audit_rows": 0,
        "phase_primary_audits": 0,
        "phase_security_events": 0,
        "phase_state_checks": 0,
    }
    issues: list[str] = []
    try:
        actions = read_phase_plan(manifest)
    except SampleVerificationError:
        return counts, ["phase plan is invalid"]
    counts["phase_actions"] = len(actions)
    if not actions:
        return counts, issues
    results = _list_phase_results(manifest, actions, issues)
    mappings = _mappings(manifest, results, issues)
    ended_sessions: list[tuple[str, str]] = []
    seen_ids: set[str] = set()
    document_ids: set[str] = set()
    seen_event_ids: set[str] = set()

    for index, action in enumerate(actions):
        result = results[index] if index < len(results) else {}
        expected_actor = _actor_id(manifest, admin_id, action.actor_key)
        if (
            result.get("action_key") != action.key
            or result.get("actor_key") != action.actor_key
            or result.get("target_key") != action.target_key
            or expected_actor is None
            or _uuid(result.get("actor_id")) != expected_actor
        ):
            issues.append("phase result identity differs from its planned action")
        rules = {
            key: rule
            for key, rule in _rules(action, manifest, mappings).items()
            if rule.method in {"POST", "PUT", "PATCH", "DELETE"}
        }
        evidence = result.get("request_evidence")
        if not rules:
            issues.append("phase action has no verification route contract")
            continue
        if not isinstance(evidence, list) or any(
            not isinstance(item, Mapping) for item in evidence
        ):
            issues.append("phase action request evidence is missing or invalid")
            continue
        counts["phase_requests"] += len(evidence)
        if [item.get("step") for item in evidence] != list(rules):
            issues.append("phase request evidence omits or reorders a planned substep")
        by_step = {item.get("step"): item for item in evidence if isinstance(item.get("step"), str)}
        if len(by_step) != len(evidence):
            issues.append("phase request evidence duplicates a substep")
        for step_name, rule in rules.items():
            item = by_step.get(step_name)
            if item is None:
                continue
            session_id = _request_matches(
                client,
                action,
                result,
                item,
                rule,
                manifest,
                admin_id,
                seen_ids,
                document_ids,
                counts,
                issues,
            )
            if rule.dynamic_session and session_id is not None:
                if rule.security_event is not None:
                    _verify_session_security_event(
                        client, rule, item, session_id, admin_id, seen_event_ids, counts, issues
                    )
                user_id = _person_id(manifest, mappings, action.target_key)
                if user_id is not None:
                    ended_sessions.append((user_id, session_id))
    _verify_final_state(client, actions, manifest, mappings, ended_sessions, counts, issues)
    if len(document_ids) > 1:
        issues.append("phase document mutations do not share a stable document identity")
    return counts, issues
