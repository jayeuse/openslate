"""The account control's second organization: an in-app invitation, acceptance and switch."""

from collections.abc import Callable, Mapping
from uuid import UUID

import httpx

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError, _read_json, _request_id


def _uuid(value: object, step: str) -> str:
    try:
        return str(UUID(str(value)))
    except ValueError:
        raise SamplePhaseActionError("Partner identity is invalid", step=step) from None


def join_partner(
    action: PhaseAction,
    dataset: SampleDataset,
    partner_admin: object,
    email: str,
    actor_id: str,
    primary: SampleClient,
    request: Callable[..., httpx.Response],
) -> tuple[str, str]:
    """The admin invites the actor to the run's partner organization; the actor joins it."""
    person = next(p for p in dataset.organization.actors.people if p.key == action.actor_key)
    if not callable(partner_admin):
        raise SamplePhaseActionError("The partner organization is unavailable", step="partner")
    admin: SampleClient = partner_admin()  # Signed in, acting in the partner organization.
    partner_id = _uuid(admin.organization_id, "partner")
    invited = admin.request(
        "POST", "/api/auth/invitations",
        json_body={"email": email, "username": person.username, "role": "member"},
    )
    if invited.status_code != 201 or _read_json(
        invited, step="invite_to_partner"
    ).get("delivery") != "in_app":
        raise SamplePhaseActionError(
            "An existing account must be invited in the app", step="invite_to_partner",
            status_code=invited.status_code, request_id=_request_id(invited),
        )
    pending = _read_json(
        request(primary, "read_partner_invitation", "GET", "/api/auth/me"),
        step="read_partner_invitation",
    ).get("pending_invitations")
    ids = [
        row.get("id") for row in (pending if isinstance(pending, list) else [])
        if isinstance(row, Mapping) and row.get("org_id") == partner_id
    ]
    if len(ids) != 1:
        raise SamplePhaseActionError(
            "The partner invitation is not pending for the actor", step="read_partner_invitation"
        )
    invitation_id = _uuid(ids[0], "read_partner_invitation")
    request(
        primary, "accept_partner_invitation", "POST",
        f"/api/auth/invitations/{invitation_id}/accept", 204,
    )
    switched = _read_json(request(
        primary, "select_partner_organization", "POST", "/api/auth/session/organization",
        body={"org_id": partner_id},
    ), step="select_partner_organization")
    current = switched.get("current_organization")
    if (switched.get("id") != actor_id or not isinstance(current, Mapping)
            or current.get("org_id") != partner_id):
        raise SamplePhaseActionError(
            "Partner organization selection readback differs", step="select_partner_organization"
        )
    return partner_id, invitation_id
