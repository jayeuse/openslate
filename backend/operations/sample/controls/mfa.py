"""Owned sample MFA lifecycle through existing application APIs."""

from collections.abc import Callable, Mapping
from contextlib import ExitStack
from time import time
from typing import Any, cast

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError, SampleWriteOutcomeUnknown
from operations.sample.controls.account import plan_account_controls
from operations.sample.controls.mfa_observation import configure_mfa_observer
from operations.sample.controls.mfa_verification import (
    CONTROL_ROUTES as CONTROL_ROUTES,
)
from operations.sample.controls.mfa_verification import (
    _factor_inventory,
    _group_members,
    _identifiers,
    _require,
    _totp,
    _uuid,
)
from operations.sample.controls.reads import plan_read_controls
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _read_json,
    _request_id,
)
from operations.sample.phases.plan import plan_phases
from operations.sample.population.people import SampleActorCredential
from operations.sample.verification.core import SampleVerificationError, list_all_rows


def plan_mfa_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    excluded = {
        key for action in plan_phases(dataset) for key in (action.actor_key, action.target_key)
    }
    excluded.add(plan_account_controls(dataset)[0].actor_key)
    excluded.update(action.target_key for action in plan_read_controls(dataset))
    members = [
        person
        for person in dataset.organization.actors.people
        if person.role == "member" and person.status == "active" and person.key not in excluded
    ]
    if len(members) < 2:
        raise ValueError(
            "MFA sample controls require two active members outside other control targets"
        )
    return (
        PhaseAction(
            key="control:account-mfa-reset",
            phase="admin",
            kind="account_controls",
            actor_key=members[0].key,
            target_key=members[1].key,
            values={"operation": "real_mfa_reset"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "aal1_reset_denied": True,
                "factors_removed": True,
                "sessions_revoked": True,
                "role_groups_restored": True,
                "primary_sessions_authenticated": True,
                "owner_mfa_unchanged": True,
            },
        ),
    )


class _Journey:
    def __init__(
        self,
        action: PhaseAction,
        dataset: SampleDataset,
        context: PhaseExecutionContext,
        on_substep: PhaseSubstep | None,
    ) -> None:
        _require(action in plan_mfa_controls(dataset), "mfa_plan")
        self.action, self.context, self.on_substep = action, context, on_substep
        self.ids = {
            key: _uuid(context.user_ids.get(key), "mfa_setup")
            for key in ("admin", action.actor_key, action.target_key)
        }
        _require(len(set(self.ids.values())) == 3, "mfa_setup")
        credentials, factory = (
            context.private_values.get(key) for key in ("credentials", "new_client")
        )
        _require(isinstance(credentials, Mapping) and callable(factory), "mfa_setup")
        self.factory = cast(Callable[[], SampleClient], factory)
        self.credentials: dict[str, SampleActorCredential] = {}
        self.people = {p.key: p for p in dataset.organization.actors.people}
        for key in (action.actor_key, action.target_key):
            credential = credentials.get(key) if isinstance(credentials, Mapping) else None
            _require(isinstance(credential, SampleActorCredential), "mfa_setup")
            credential = cast(SampleActorCredential, credential)
            _require(
                credential.user_id == self.ids[key]
                and credential.email == self.people[key].email
                and bool(credential.password)
                and sum(value == self.ids[key] for value in context.user_ids.values()) == 1,
                "mfa_setup",
            )
            self.credentials[key] = credential
        _require(all(key in context.clients for key in self.ids), "mfa_setup")
        self.admin = context.clients["admin"]
        self.evidence: list[dict[str, object]] = []

    def observed(
        self,
        key: str,
        step: str,
        method: str,
        path: str,
        response: httpx.Response,
        expected: int,
    ) -> httpx.Response:
        request_id = _request_id(response)
        _require(request_id is not None, step)
        if method != "GET":
            self.evidence.append(
                {
                    "step": step,
                    "actor_key": key,
                    "actor_id": self.ids[key],
                    "method": method,
                    "path": path,
                    "status_code": response.status_code,
                    "expected_status": expected,
                    "request_id": request_id,
                }
            )
        if response.status_code != expected:
            raise SamplePhaseActionError(
                "MFA request did not match its planned result",
                step=step,
                status_code=response.status_code,
                request_id=request_id,
            )
        return response

    def request(
        self,
        key: str,
        step: str,
        method: str,
        path: str,
        expected: int = 200,
        *,
        client: SampleClient | None = None,
        body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        if self.on_substep is not None:
            self.on_substep(step)
        response = (client or self.context.clients[key]).request(
            method,
            path,
            json_body=body,
            headers=headers,
            params=params,
            refresh_first=False,
        )
        return self.observed(key, step, method, path, response, expected)

    def read(
        self, key: str, step: str, path: str, client: SampleClient | None = None
    ) -> dict[str, Any]:
        return _read_json(self.request(key, step, "GET", path, client=client), step=step)

    def login(self, key: str, step: str, client: SampleClient, role: str) -> None:
        if self.on_substep is not None:
            self.on_substep(step)
        credential = self.credentials[key]
        self.observed(
            key,
            step,
            "POST",
            "/api/auth/login",
            client.login(credential.email, credential.password),
            200,
        )
        self.person(key, f"{step}_identity", self.read(key, step, "/api/auth/me", client), role)

    def person(self, key: str, step: str, body: Mapping[str, Any], role: str = "member") -> None:
        _require(
            body.get("id") == self.ids[key]
            and body.get("role") == role
            and body.get("status") == "active"
            and body.get("email") == self.people[key].email
            and body.get("username") == self.people[key].username,
            step,
        )

    def factors(
        self, key: str, step: str, client: SampleClient | None = None
    ) -> tuple[str, list[dict[str, str]]]:
        return _factor_inventory(self.read(key, step, "/api/auth/mfa", client), self.ids[key], step)

    def sessions(self, key: str) -> list[str]:
        rows = list_all_rows(self.admin, f"/api/users/{self.ids[key]}/sessions")
        return sorted(_identifiers([row.get("id") for row in rows], "mfa_sessions"))

    def enroll(self, key: str, prefix: str, client: SampleClient, *, verify: bool) -> str:
        response = self.request(
            key,
            f"{prefix}_enroll",
            "POST",
            "/api/auth/mfa/factors",
            201,
            client=client,
            body={"friendly_name": "Owned sample acceptance"},
        )
        body = _read_json(response, step=f"{prefix}_enroll")
        factor = _uuid(body.get("id"), f"{prefix}_enroll")
        _, pending = self.factors(key, f"{prefix}_pending", client)
        _require(pending == [{"id": factor, "factor_type": "totp", "status": "unverified"}], prefix)
        if verify:
            totp = body.get("totp")
            secret = totp.get("secret") if isinstance(totp, Mapping) else None
            _require(isinstance(secret, str) and bool(secret), f"{prefix}_verify")
            verified = _read_json(
                self.request(
                    key,
                    f"{prefix}_verify",
                    "POST",
                    f"/api/auth/mfa/factors/{factor}/verification",
                    client=client,
                    body={"code": _totp(cast(str, secret), time())},
                ),
                step=f"{prefix}_verify",
            )
            _require(verified == {"verified": True, "access_token": None}, f"{prefix}_verify")
            aal, current = self.factors(key, f"{prefix}_aal2", client)
            _require(
                aal == "aal2"
                and current == [{"id": factor, "factor_type": "totp", "status": "verified"}],
                f"{prefix}_aal2",
            )
        return factor

    def ended(self, key: str, prefix: str, client: SampleClient, *, refresh: bool = True) -> None:
        body = self.read(key, f"{prefix}_ended", "/api/auth/session", client)
        _require(body.get("authenticated") is False, f"{prefix}_ended")
        if refresh:
            if self.on_substep is not None:
                self.on_substep(f"{prefix}_refresh_refused")
            self.observed(
                key, f"{prefix}_refresh_refused", "POST", "/api/auth/refresh", client.refresh(), 401
            )

    def security(self, key: str) -> dict[str, Any]:
        body = self.read("admin", "mfa_security", f"/api/users/{self.ids[key]}/security")
        _require(
            body.get("user_id") == self.ids[key]
            and body.get("target_eligible") is True
            and type(body.get("verified_factor_count")) is int,
            "mfa_security",
        )
        return body

    def reconcile(self) -> None:
        safe: dict[str, object] = {
            "action_key": self.action.key,
            "actor_id": self.ids[self.action.actor_key],
            "target_id": self.ids[self.action.target_key],
        }
        for key in (self.action.actor_key, self.action.target_key):
            try:
                person = self.read("admin", "mfa_reconcile", f"/api/users/{self.ids[key]}")
                safe[key] = {
                    "role": person.get("role"),
                    "status": person.get("status"),
                    "verified_factor_count": self.security(key)["verified_factor_count"],
                    "active_session_ids": self.sessions(key),
                }
            except (SampleClientError, SamplePhaseActionError, SampleVerificationError):
                safe[key] = {"readback": "unavailable"}
        self.context.private_values["mfa_reconciliation"] = safe


def execute_mfa_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    run = _Journey(action, dataset, context, on_substep)
    observe = configure_mfa_observer(context.private_values, action, run.ids)
    actor, target = action.actor_key, action.target_key
    actor_id, target_id = run.ids[actor], run.ids[target]
    owner = run.read("admin", "mfa_owner", "/api/auth/me")
    owner_state = tuple(owner.get(key) for key in ("id", "role", "status"))
    _require(owner_state == (run.ids["admin"], "admin", "active"), "mfa_owner")
    _, owner_factors = run.factors("admin", "mfa_owner_inventory")
    for key in (actor, target):
        run.person(key, "mfa_person", run.read("admin", "mfa_person", f"/api/users/{run.ids[key]}"))
        run.person(key, "mfa_primary", run.read(key, "mfa_primary", "/api/auth/me"))
        aal, factors = run.factors(key, "mfa_initial_factors")
        _require(aal == "aal1" and factors == [], "mfa_initial_factors")
    original_groups = _group_members(run.admin)
    group_ids: dict[str, list[str]] = {}
    for key in (actor, target):
        wanted = sorted(
            _uuid(context.group_ids.get(group), "mfa_groups") for group in run.people[key].groups
        )
        found = sorted(
            group for group, members in original_groups.items() if run.ids[key] in members
        )
        _require(wanted == found, "mfa_groups")
        group_ids[key] = found
    actor_sessions, target_sessions = run.sessions(actor), run.sessions(target)
    _require(bool(actor_sessions) and bool(target_sessions), "mfa_sessions")
    before_security = run.security(target)
    try:
        with ExitStack() as stack:
            promoted = _read_json(
                run.request(
                    "admin",
                    "promote_actor",
                    "PATCH",
                    f"/api/users/{actor_id}",
                    body={"role": "admin"},
                ),
                step="promote_actor",
            )
            run.person(actor, "promote_actor", promoted, "admin")
            _require(
                _group_members(run.admin)
                == {
                    group: [uid for uid in members if uid != actor_id]
                    for group, members in original_groups.items()
                },
                "promote_groups",
            )
            acting = stack.enter_context(run.factory())
            run.login(actor, "login_actor", acting, "admin")
            _require(run.factors(actor, "actor_aal1", acting)[0] == "aal1", "actor_aal1")
            actor_sessions = run.sessions(actor)
            denial = _read_json(
                run.request(
                    actor,
                    "deny_aal1_reset",
                    "POST",
                    f"/api/users/{target_id}/mfa/reset",
                    403,
                    client=acting,
                    body={},
                ),
                step="deny_aal1_reset",
            )
            _require(
                isinstance(denial.get("detail"), Mapping)
                and denial["detail"].get("code") == "security_aal2_required"
                and run.security(target) == before_security
                and run.sessions(target) == target_sessions
                and run.factors(target, "denial_target_factors")[1] == [],
                "deny_aal1_reset",
            )
            cancelled = run.enroll(actor, "cancel", acting, verify=False)
            run.request(
                actor,
                "cancel_factor",
                "DELETE",
                f"/api/auth/mfa/factors/{cancelled}",
                204,
                client=acting,
                params={"unverified_only": True},
            )
            _require(run.factors(actor, "cancelled_factors", acting)[1] == [], "cancel_factor")
            actor_factor = run.enroll(actor, "actor", acting, verify=True)
            extra_target = stack.enter_context(run.factory())
            run.login(target, "login_target", extra_target, "member")
            target_factor = run.enroll(target, "target", context.clients[target], verify=True)
            target_sessions = run.sessions(target)
            _require(len(target_sessions) >= 2, "capture_target_sessions")
            observe("before_reset", actor_sessions, target_sessions)
            receipt = _read_json(
                run.request(
                    actor,
                    "reset_target_mfa",
                    "POST",
                    f"/api/users/{target_id}/mfa/reset",
                    client=acting,
                    body={},
                ),
                step="reset_target_mfa",
            )
            _uuid(receipt.get("operation_id"), "reset_target_mfa")
            _require(
                set(receipt)
                == {
                    "operation_id",
                    "user_id",
                    "factors_cleared",
                    "local_revocation",
                    "revoked_sessions",
                }
                and receipt.get("user_id") == target_id
                and receipt.get("factors_cleared") is True
                and receipt.get("local_revocation") == "committed"
                and type(receipt.get("revoked_sessions")) is int
                and receipt.get("revoked_sessions") == len(target_sessions),
                "reset_target_mfa",
            )
            _require(
                run.security(target)["verified_factor_count"] == 0
                and not set(target_sessions) & set(run.sessions(target)),
                "target_reset_readback",
            )
            run.ended(target, "target_primary", context.clients[target])
            run.ended(target, "target_extra", extra_target)
            run.request(
                actor,
                "remove_actor_factor",
                "DELETE",
                f"/api/auth/mfa/factors/{actor_factor}",
                204,
                client=acting,
            )
            run.ended(actor, "actor_acting", acting, refresh=False)
            run.ended(actor, "actor_primary", context.clients[actor])
            _require(
                run.security(actor)["verified_factor_count"] == 0
                and not set(actor_sessions) & set(run.sessions(actor)),
                "actor_cleanup",
            )
            restored = _read_json(
                run.request(
                    "admin",
                    "restore_actor_role",
                    "PATCH",
                    f"/api/users/{actor_id}",
                    body={"role": "member"},
                ),
                step="restore_actor_role",
            )
            run.person(actor, "restore_actor_role", restored)
            for group in group_ids[actor]:
                response = run.request(
                    "admin", "restore_group_read", "GET", f"/api/access/groups/{group}"
                )
                body = _read_json(response, step="restore_group_read")
                _require(
                    body.get("id") == group
                    and type(body.get("revision")) is int
                    and sorted(body.get("member_ids", []))
                    == [uid for uid in original_groups[group] if uid != actor_id]
                    and response.headers.get("ETag") == f'"{group}:{body["revision"]}"',
                    "restore_group_read",
                )
                run.request(
                    "admin",
                    f"restore_group:{group}",
                    "PUT",
                    f"/api/access/groups/{group}/members",
                    body={"member_ids": original_groups[group]},
                    headers={"If-Match": response.headers["ETag"]},
                )
            _require(_group_members(run.admin) == original_groups, "restore_groups")
            observe("after_revocation", actor_sessions, target_sessions)
            for key in (actor, target):
                run.login(
                    key,
                    f"restore_{'actor' if key == actor else 'target'}_primary",
                    context.clients[key],
                    "member",
                )
                _require(run.factors(key, "final_owned_factors")[1] == [], "final_owned_factors")
            _require(
                run.factors("admin", "final_owner_factors")[1] == owner_factors,
                "final_owner_factors",
            )
    except SampleWriteOutcomeUnknown:
        run.reconcile()
        raise
    # fmt: off
    return {
        "action_key": action.key, "kind": action.kind, "actor_key": actor, "target_key": target,
        "actor_id": actor_id, "target_id": target_id, "status": "complete",
        **action.expected_end_state, "actor_aal2_observed": True, "target_aal2_observed": True,
        "cancelled_factor_id": cancelled, "actor_factor_id": actor_factor,
        "target_factor_id": target_factor, "actor_session_ids": actor_sessions,
        "target_session_ids": target_sessions, "original_actor_group_ids": group_ids[actor],
        "original_target_group_ids": group_ids[target], "original_group_members": original_groups,
        "owner_factors": owner_factors, "reset_receipt": receipt,
        "request_evidence": run.evidence, "mappings": [],
    }
    # fmt: on
