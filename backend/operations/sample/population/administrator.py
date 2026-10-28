"""The pack organization's own administrator, invited by the installation operator.

The operator owns the installation and creates the pack organization. Right after the pristine
baseline, the operator invites one pack administrator in the pack's own email domain; the
administrator completes the invitation through the owned Mailpit and then runs population and
every organization control. The generated password stays in the run's owner-only roster.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping, MutableMapping
from pathlib import Path
from uuid import UUID

from operations.sample.client import SampleClient, SampleClientError, SampleWriteOutcomeUnknown
from operations.sample.organization import pack_administrator_email
from operations.sample.packs.interface import OrganizationPack
from operations.sample.population.invitations import (
    CredentialRoster,
    InvitationMailbox,
    SampleInvitationError,
)
from operations.sample.population.people import (
    SampleActorCredential,
    SamplePeopleError,
    _write_data,
    people_roster_rows,
)
from operations.sample.population.run import SamplePopulationError, _login

ADMINISTRATOR_KEY = "administrator"
_USERNAME = re.compile(r"[a-z0-9_-]{3,100}\Z")


def administrator_identity(pack: OrganizationPack) -> dict[str, str]:
    """The pack administrator's account: the pack's own domain, a username from the pack key."""
    identity = pack.identity
    username = f"{identity.key}-administrator"
    if not _USERNAME.fullmatch(username):
        raise SamplePopulationError("The pack key does not form a valid administrator username")
    return {
        "key": ADMINISTRATOR_KEY,
        "email": pack_administrator_email(pack),
        "username": username,
        "display_name": f"{identity.workspace_name} Administrator",
        "job_title": "Organization administrator",
        "role": "admin",
        "status": "active",
    }


def create_run_roster(path: Path, pack: OrganizationPack) -> CredentialRoster:
    """Create the run's private roster: the pack administrator first, then the pack's people."""
    rows = [administrator_identity(pack), *people_roster_rows(pack)]
    for field in ("key", "email", "username"):
        values = [row[field].casefold() for row in rows]
        if len(set(values)) != len(values):
            raise SamplePopulationError(f"The pack administrator {field} collides with a person")
    try:
        return CredentialRoster.create(path, rows)
    except SampleInvitationError as error:
        raise SamplePopulationError(str(error)) from None


def invite_pack_administrator(
    operator: SampleClient,
    roster: CredentialRoster,
    *,
    api_url: str,
    origin: str,
    mailpit_url: str,
    organization_id: str | None,
    operator_id: str,
) -> SampleActorCredential:
    """Invite the pack administrator as the operator and complete it through Mailpit."""
    account = roster.accounts[ADMINISTRATOR_KEY]
    key, email = ADMINISTRATOR_KEY, str(account["email"])
    mailbox = InvitationMailbox(mailpit_url, origin)
    try:
        baseline = mailbox.snapshot()
        roster.operation("user-invite", key, "started")
        invited = _write_data(
            roster,
            "user-invite",
            key,
            operator.request(
                "POST",
                "/api/auth/invitations",
                json_body={
                    field: account[field]
                    for field in ("email", "username", "display_name", "job_title", "role")
                },
            ),
            201,
            "Administrator invitation",
        )
        user = invited.get("user")
        try:
            user_id = str(UUID(str(user.get("id") if isinstance(user, Mapping) else None)))
        except ValueError:
            roster.operation("user-invite", key, "outcome_unknown")
            raise SamplePopulationError(
                "Administrator invitation returned an unusable server ID"
            ) from None
        if invited.get("delivery") != "email" or user_id == operator_id:
            raise SamplePopulationError("The pack administrator must be a new account")
        roster.set_account(key, state="invited", user_id=user_id)
        try:
            token = mailbox.invitation_token(baseline, email)
        except SampleInvitationError:
            roster.set_account(key, state="email_not_confirmed")
            raise SamplePopulationError(
                "No matching invite email for the pack administrator; roster retained"
            ) from None
        password = roster.password(key)
        roster.operation("invitation-complete", key, "started")
        acceptance = SampleClient(
            api_url, origin, roster.path.parent / "invitation-requests.jsonl", organization_id
        )
        try:
            completed = acceptance.complete_invitation(token, password)
        except SampleWriteOutcomeUnknown:
            roster.operation("invitation-complete", key, "outcome_unknown")
            raise SamplePopulationError(
                "Administrator completion outcome is unknown; reconcile before rebuilding"
            ) from None
        except SampleClientError:
            roster.operation("invitation-complete", key, "failed")
            raise SamplePopulationError("Administrator invitation completion failed") from None
        finally:
            acceptance.close()
        _write_data(roster, "invitation-complete", key, completed, 204, "Invitation completion")
        roster.set_account(key, state="active")
        readback = operator.request("GET", f"/api/users/{user_id}")
        profile = readback.json() if readback.status_code == 200 else {}
        if not isinstance(profile, Mapping) or any(
            profile.get(field) != expected
            for field, expected in (
                ("id", user_id),
                ("email", email),
                ("username", account["username"]),
                ("role", "admin"),
                ("status", "active"),
            )
        ):
            raise SamplePopulationError("Administrator readback did not match the invitation")
        return SampleActorCredential(user_id, email, password)
    except SamplePeopleError as error:
        raise SamplePopulationError(str(error)) from None
    except (SampleClientError, SampleInvitationError, ValueError):
        raise SamplePopulationError(
            "The pack administrator invitation failed; inspect the private run journal"
        ) from None
    finally:
        mailbox.close()


def partner_client_factory(
    *,
    api_url: str,
    origin: str,
    journal: Path,
    partner_organization_id: str,
    clients: MutableMapping[str, SampleClient],
    operator: tuple[str, str, str],
    actors: Mapping[str, SampleActorCredential],
) -> Callable[..., SampleClient]:
    """Sign in one client to the partner organization; its administrator is the operator."""

    def partner_client(actor_key: str = "admin") -> SampleClient:
        client = SampleClient(api_url, origin, journal, partner_organization_id)
        clients[f"partner-{actor_key}-{len(clients)}"] = client
        if actor_key == "admin":
            email, password, user_id = operator
        else:
            credential = actors[actor_key]
            email, password, user_id = credential.email, credential.password, credential.user_id
        _login(client, email, password, expected_id=user_id)
        return client

    return partner_client

