"""API-only S17 preference/settings journeys and current owned-state reconciliation."""

from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from pydantic import TypeAdapter, ValidationError

from app.systems.comms.messages.schemas import CategoryPreferences, MemberPreferences
from app.systems.comms.settings.schemas import (
    CapabilityCheck,
    CapabilityConfiguration,
    CapabilityLocks,
    CreationCheck,
    PersonalPreferences,
    SettingsResponse,
    WorkspaceSettingsResponse,
)
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.comms_structure_common import bound_context, check
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _read_json,
    _request,
    _result,
)

ADAPTERS: dict[str, TypeAdapter[Any]] = {
    key: TypeAdapter(model)
    for key, model in (
        ("personal", PersonalPreferences),
        ("member", MemberPreferences),
        ("category", CategoryPreferences),
        ("settings", SettingsResponse),
        ("workspace", WorkspaceSettingsResponse),
        ("configuration", CapabilityConfiguration),
        ("locks", CapabilityLocks),
        ("check", CapabilityCheck),
        ("creation", CreationCheck),
    )
}
PREFERENCE_STEPS = ("personal", "member", "category")


def plan_settings_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return tuple(
        PhaseAction(
            key=f"control:comms:{org}-settings",
            phase="reorganization",
            kind="comms_controls",
            actor_key="admin",
            target_key=f"{org}:comms:messages",
            values={
                "operation": "preferences_settings"
                if org == "primary"
                else "partner_preferences_settings",
                "organization": org,
            },
            expected_status=200,
            expected_detail=None,
            expected_end_state={"configuration_verified": True, "preferences_restored": True},
        )
        for org in ("primary", "partner")
    )


def _parse(
    response: httpx.Response, kind: str, *, org: str, scope: dict[str, Any] | None = None
) -> dict[str, Any]:
    try:
        value: dict[str, Any] = (
            ADAPTERS[kind]
            .validate_json(response.content)
            .model_dump(
                mode="json",
                exclude_unset=True,
            )
        )
    except ValidationError as exc:
        raise SamplePhaseActionError("Invalid settings response", step=kind) from exc
    if kind in {"settings", "workspace", "check", "creation"}:
        check(value["org_id"] == org, "settings_context")
    if scope is not None:
        check(value.get("scope") == scope, "settings_scope")
    if kind not in {"check", "creation"}:
        tag = response.headers.get("ETag", "")
        check(len(tag) > 2 and tag.startswith('"') and tag.endswith('"'), "settings_validator")
    return value


def execute_settings_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_settings_controls(dataset):
        raise SamplePhaseActionError("Unsupported settings operation", step=action.key)
    organization = str(action.values["organization"])
    if organization == "partner":
        factory = context.private_values.get("partner_admin")
        if not callable(factory):
            raise SamplePhaseActionError("Partner client is unavailable", step=action.key)
        client = factory()
        check(client.organization_id != context.clients["admin"].organization_id, "partner_binding")
        context = bound_context(context, {**context.clients, "admin": client})
    client = context.clients["admin"]
    org = _id({"org": client.organization_id}, "org", label="organization", step=action.key)
    actor = _id(context.user_ids, "admin", label="actor", step=action.key)
    conversation = _mapped_id(
        context, "comms_conversations", f"{organization}:comms:messages", step=action.key
    )
    category = _mapped_id(
        context, "comms_categories", f"{organization}:comms:category", step=action.key
    )
    root, cpath = "/api/comms", f"/api/comms/conversations/{conversation}"
    evidence: list[dict[str, object]] = []
    baseline: dict[str, dict[str, Any]] = {}

    def call(method: str, path: str, step: str, **kwargs: Any) -> httpx.Response:
        return _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method=method,
            path=path,
            step=step,
            expected=200,
            on_substep=on_substep,
            **kwargs,
        )

    def read(
        path: str, kind: str, scope: dict[str, Any] | None = None
    ) -> tuple[dict[str, Any], str]:
        response = call("GET", path, "read:" + kind)
        return _parse(response, kind, org=org, scope=scope), response.headers.get("ETag", "")

    for kind, method, path, patch in (
        (
            "personal",
            "PUT",
            root + "/preferences",
            {
                "density": "compact",
                "notifications": {"quiet_hours_start": "22:00", "quiet_hours_end": "06:00"},
            },
        ),
        ("member", "PATCH", cpath + "/preferences", {"starred": True, "manual_unread": True}),
        ("category", "PUT", f"{root}/categories/{category}/preferences", {"collapsed": True}),
    ):
        original, _ = read(path, kind)
        baseline[path] = original
        body = {**original, **patch}
        accepted = _parse(call(method, path, "change:" + kind, json_body=body), kind, org=org)
        check(accepted == body and read(path, kind)[0] == body, "preference_readback")
        _parse(call(method, path, "restore:" + kind, json_body=original), kind, org=org)
        check(read(path, kind)[0] == original, "preference_restore")
    workspace = root + "/settings/workspace"
    original_workspace, _ = read(workspace, "workspace", {"kind": "workspace"})
    check("formatting" not in original_workspace["locked_keys"], "sample_formatting_unlocked")
    scopes = [
        (workspace, {"kind": "workspace"}, "workspace"),
        (f"{root}/settings/category/{category}", {"kind": "category", "id": category}, "settings"),
        (
            f"{root}/settings/channel/{conversation}",
            {"kind": "channel", "id": conversation},
            "settings",
        ),
    ]
    for path, scope, kind in scopes:
        original, tag = read(path, kind, scope)
        baseline[path] = original
        value = not original["effective"]["formatting"]
        saved = _parse(
            call(
                "PATCH",
                path,
                "patch:" + scope["kind"],
                json_body={"formatting": value},
                headers={"If-Match": tag},
            ),
            kind,
            org=org,
            scope=scope,
        )
        check(
            saved["overrides"]["formatting"] is value and read(path, kind, scope)[0] == saved,
            "settings_readback",
        )
        _, tag = read(path, kind, scope)
        reset = _parse(
            call(
                "POST",
                path + "/reset",
                "reset:" + scope["kind"],
                json_body={"keys": ["formatting"]},
                headers={"If-Match": tag},
            ),
            kind,
            org=org,
            scope=scope,
        )
        check("formatting" not in reset["overrides"], "settings_reset")
        if "formatting" in original["overrides"]:
            _, tag = read(path, kind, scope)
            call(
                "PATCH",
                path,
                "restore_setting:" + scope["kind"],
                headers={"If-Match": tag},
                json_body={"formatting": original["overrides"]["formatting"]},
            )
        check(read(path, kind, scope)[0] == original, "settings_restore")
        cap_path = path + "/capabilities"
        configuration, tag = read(cap_path, "configuration", scope)
        baseline[cap_path] = configuration
        updated = {**configuration, "everyone": {**configuration["everyone"], "reply": False}}
        accepted = _parse(
            call(
                "PUT",
                cap_path,
                "grants:" + scope["kind"],
                headers={"If-Match": tag},
                json_body=updated,
            ),
            "configuration",
            org=org,
            scope=scope,
        )
        check(
            accepted == updated and read(cap_path, "configuration", scope)[0] == updated,
            "configuration_readback",
        )
        _, tag = read(cap_path, "configuration", scope)
        call(
            "PUT",
            cap_path,
            "restore_grants:" + scope["kind"],
            headers={"If-Match": tag},
            json_body=configuration,
        )
        check(read(cap_path, "configuration", scope)[0] == configuration, "configuration_restore")
    _, tag = read(workspace, "workspace")
    call(
        "PUT",
        workspace + "/locks",
        "lock_settings",
        headers={"If-Match": tag},
        json_body={"keys": [*original_workspace["locked_keys"], "formatting"]},
    )
    check("formatting" in read(workspace, "workspace")[0]["locked_keys"], "settings_lock_readback")
    _, tag = read(workspace, "workspace")
    call(
        "PUT",
        workspace + "/locks",
        "restore_settings_locks",
        headers={"If-Match": tag},
        json_body={"keys": original_workspace["locked_keys"]},
    )
    locks_path = workspace + "/capability-locks"
    locks, tag = read(locks_path, "locks")
    baseline[locks_path] = locks
    changed_locks = {"capabilities": sorted(set(locks["capabilities"]) | {"pin"})}
    accepted = _parse(
        call(
            "PUT",
            locks_path,
            "lock_capabilities",
            headers={"If-Match": tag},
            json_body=changed_locks,
        ),
        "locks",
        org=org,
    )
    check(
        accepted == changed_locks and read(locks_path, "locks")[0] == changed_locks,
        "capability_lock_readback",
    )
    _, tag = read(locks_path, "locks")
    call("PUT", locks_path, "restore_capability_locks", headers={"If-Match": tag}, json_body=locks)
    own = _parse(call("GET", cpath + "/capabilities", "own_capabilities"), "check", org=org)
    check(own["user_id"] == actor and own["conversation_id"] == conversation, "capability_context")
    members = _read_json(call("GET", cpath + "/members", "owned_members"), step="owned_members")
    others = [row["user_id"] for row in members["items"] if row["user_id"] != actor]
    check(bool(others), "owned_inspection_subject")
    person = _parse(
        call("GET", cpath + "/capabilities/" + others[0], "inspect_person"), "check", org=org
    )
    check(
        person["user_id"] == others[0] and person["conversation_id"] == conversation,
        "inspection_context",
    )
    for query in ({"scope_kind": "workspace"}, {"scope_kind": "category", "category_id": category}):
        check_row = _parse(
            call("GET", root + "/capabilities/channel-creation", "creation_check", params=query),
            "creation",
            org=org,
        )
        check(check_row["user_id"] == actor, "creation_context")
    result = _result(
        action,
        context,
        evidence,
        [],
        extra={
            "organization_id": org,
            "conversation_id": conversation,
            "category_id": category,
            "configuration_verified": True,
            "preferences_restored": True,
            "baseline": baseline,
        },
    )
    issues = verify_settings_control(client, action, result, context.runtime_mappings, actor)
    if issues:
        raise SamplePhaseActionError("Settings final readback differs", step=action.key)
    return result


def verify_settings_control(
    client: SampleClient,
    action: PhaseAction,
    result: Mapping[str, Any],
    mappings: Mapping[str, Any],
    admin_id: str,
) -> list[str]:
    organization = action.values["organization"]
    conversation = mappings.get("comms_conversations", {}).get(f"{organization}:comms:messages")
    category = mappings.get("comms_categories", {}).get(f"{organization}:comms:category")
    issues = []
    expected_steps = [
        f"{operation}:{kind}" for kind in PREFERENCE_STEPS for operation in ("change", "restore")
    ]
    expected_steps += [
        f"{operation}:{kind}"
        for kind in ("workspace", "category", "channel")
        for operation in ("patch", "reset", "grants", "restore_grants")
    ]
    expected_steps += [
        "lock_settings",
        "restore_settings_locks",
        "lock_capabilities",
        "restore_capability_locks",
    ]
    receipts = result.get("request_evidence", [])
    steps = [
        r.get("step") for r in receipts if not str(r.get("step")).startswith("restore_setting:")
    ]
    if (
        steps != expected_steps
        or any(r.get("status_code") != 200 or not r.get("request_id") for r in receipts)
        or result.get("actor_id") != admin_id
        or result.get("organization_id") != client.organization_id
        or result.get("conversation_id") != conversation
        or result.get("category_id") != category
        or result.get("configuration_verified") is not True
        or result.get("preferences_restored") is not True
    ):
        issues.append("Settings execution evidence differs")
    baseline = result.get("baseline", {})
    allowed = {
        "/api/comms/preferences",
        f"/api/comms/conversations/{conversation}/preferences",
        f"/api/comms/categories/{category}/preferences",
        "/api/comms/settings/workspace/capability-locks",
        *(
            f"/api/comms/settings/{scope}{suffix}"
            for scope in (
                "workspace",
                f"category/{category}",
                f"channel/{conversation}",
            )
            for suffix in ("", "/capabilities")
        ),
    }
    if set(baseline) != allowed:
        return [*issues, "Owned settings readback set differs"]
    for path in sorted(allowed):
        response = client.request("GET", path)
        if (
            response.status_code != 200
            or _read_json(response, step="settings_verify") != baseline[path]
        ):
            issues.append("Owned settings state differs")
    return issues


def verify_settings_runs(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    *,
    api_url: str,
    origin: str,
    journal: Path,
    operator_login: tuple[str, str],
    operator_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Final verification rebinds the run's partner explicitly, never through session selection."""
    rows = manifest.get("control_results", [])
    actions = plan_settings_controls(dataset)
    if not any(
        isinstance(row, Mapping) and row.get("action_key") in {a.key for a in actions}
        for row in rows
    ):
        return {}, []
    count, issues = 0, []
    for action in actions:
        matches = [
            row for row in rows if isinstance(row, Mapping) and row.get("action_key") == action.key
        ]
        if len(matches) != 1:
            issues.append("Settings control result is missing or duplicated")
            continue
        row = matches[0]
        if action.values["organization"] == "primary":
            current = verify_settings_control(
                client, action, row, manifest.get("mappings", {}), admin_id
            )
        else:
            try:
                partner_id = str(UUID(str(manifest.get("partner_organization_id"))))
            except ValueError:
                issues.append("Partner settings organization is invalid")
                continue
            if partner_id == client.organization_id or row.get("organization_id") != partner_id:
                issues.append("Partner settings binding differs")
                continue
            with SampleClient(api_url, origin, journal, partner_id) as partner:
                if partner.login(*operator_login).status_code != 200:
                    issues.append("Partner settings verification sign-in failed")
                    continue
                try:
                    current = verify_settings_control(
                        partner, action, row, manifest.get("mappings", {}), operator_id
                    )
                finally:
                    partner.request("POST", "/api/auth/logout")
        issues.extend(current)
        count += not current
    return {"comms_settings_verified": count}, issues
