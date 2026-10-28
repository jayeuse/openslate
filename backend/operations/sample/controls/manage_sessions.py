"""The pack administrator's bulk session revocation: shared accounts keep their sessions.

The server ends every other session of accounts that belong only to this organization. For an
administrator who is not the installation operator it keeps the sessions of accounts that also
belong to another organization: the operator and the members who joined the partner.
"""

from collections.abc import Callable, Mapping
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.controls.manage import (
    _SESSION_QUERY,
    _primary_keys,
    _shared_primary_keys,
)
from operations.sample.controls.planned_actors import OPERATOR
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError, _id
from operations.sample.population.people import SampleActorCredential

Read = Callable[..., dict[str, Any]]
Write = Callable[..., dict[str, Any]]
Sessions = Callable[..., list[dict[str, Any]]]


def _credentials(
    action: PhaseAction, dataset: SampleDataset, context: PhaseExecutionContext
) -> dict[str, SampleActorCredential]:
    raw = context.private_values.get("credentials")
    primary = set(context.clients) & set(context.user_ids) - {"admin", OPERATOR}
    if primary != set(_primary_keys(dataset)) or not isinstance(raw, Mapping):
        raise SamplePhaseActionError(
            "Primary actor login prerequisites are incomplete", step=action.key
        )
    credentials: dict[str, SampleActorCredential] = {}
    for key in sorted(primary):
        value = raw.get(key)
        person = next(p for p in dataset.organization.actors.people if p.key == key)
        actor_id = _id(context.user_ids, key, label="primary actor", step=action.key)
        if (
            not isinstance(value, SampleActorCredential)
            or value.user_id != actor_id
            or value.email != person.email
            or not value.password
            or sum(uid == actor_id for uid in context.user_ids.values()) != 1
        ):
            raise SamplePhaseActionError(
                "Primary actor credential binding is invalid", step=action.key
            )
        credentials[key] = value
    return credentials


def revoke_admin_sessions(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    read: Read,
    write: Write,
    sessions: Sessions,
) -> dict[str, object]:
    credentials = _credentials(action, dataset, context)
    shared = set(_shared_primary_keys(dataset))
    admin_id = _id(context.user_ids, "admin", label="administrator", step=action.key)
    operator_id = _id(context.user_ids, OPERATOR, label="operator", step=action.key)
    shared_ids = {operator_id} | {credentials[key].user_id for key in shared}
    if admin_id in shared_ids:
        raise SamplePhaseActionError(
            "The pack administrator must belong only to this organization", step=action.key
        )
    current = {**_SESSION_QUERY, "limit": 100, "status": "current"}
    remote = {**_SESSION_QUERY, "limit": 100, "status": "remote"}
    before = sessions(current)
    if (
        len(before) != 1
        or before[0]["current"] is not True
        or before[0]["user_id"] != admin_id
        or not sessions(remote)
    ):
        raise SamplePhaseActionError(
            "Bulk session revocation has no valid current and remote sessions", step=action.key
        )
    headers = write("revoke_admin_sessions", "admin", "DELETE", "/api/auth/admin-sessions", 204)
    if headers.get("x-skipped-shared-accounts") != str(len(shared_ids)):
        raise SamplePhaseActionError(
            "Bulk session revocation skipped other accounts than the shared ones",
            step=action.key,
        )
    after = sessions(current)
    kept = sessions(remote)
    if (
        len(after) != 1
        or after[0]["id"] != before[0]["id"]
        or after[0]["user_id"] != admin_id
        or not kept
        or any(row["user_id"] not in shared_ids for row in kept)
        or operator_id not in {row["user_id"] for row in kept}
    ):
        raise SamplePhaseActionError(
            "Bulk session revocation did not keep exactly the shared accounts", step=action.key
        )
    # A revoked session cannot refresh, so its probe reads without refreshing first; a kept
    # session refreshes first, since its access token may have expired since its last use.
    for key, credential in credentials.items():
        probe = read("/api/auth/session", actor=key, refresh_first=key in shared)
        authenticated = probe.get("authenticated") is True
        if authenticated != (key in shared) or (
            authenticated and probe.get("user_id") != credential.user_id
        ):
            raise SamplePhaseActionError(
                "A primary session differs from its shared or revoked plan", step=action.key
            )
    probe = read("/api/auth/session", actor=OPERATOR, refresh_first=True)
    if probe.get("authenticated") is not True or probe.get("user_id") != operator_id:
        raise SamplePhaseActionError(
            "The operator's session ended in a pack administrator revocation", step=action.key
        )
    for key, credential in credentials.items():
        if key in shared:
            continue
        write(f"reauth:{key}", key, "POST", "/api/auth/login", 200, credential=credential)
        identity = read("/api/auth/me", actor=key)
        if (
            identity.get("id") != credential.user_id
            or identity.get("role") != "member"
            or identity.get("status") != "active"
        ):
            raise SamplePhaseActionError(
                "Primary actor reauthentication resolved another identity", step=action.key
            )
    return {
        "sessions_revoked": True,
        "primary_sessions_authenticated": True,
        "shared_sessions_kept": True,
    }
