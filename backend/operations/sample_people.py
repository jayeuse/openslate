"""Harbor sample identities and Access groups populated through the UI APIs."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx

from operations.sample_client import SampleClient, SampleClientError, SampleWriteOutcomeUnknown
from operations.sample_invitations import (
    CredentialRoster,
    InvitationMailbox,
    SampleInvitationError,
)
from operations.sample_vocabulary import GUEST_DOMAINS, INTERNAL_DOMAIN, TEAM_ROSTER, TEAM_TITLES

_DEPARTMENTS = ("sales", "service", "field", "inventory", "purchasing", "finance")
_MODULES = ("inspections", "products", "purchase_orders", "invoices")
_TEAM_GROUPS = {
    "sales": "sales-desk",
    "service": "service-triage",
    "field": "field-operations",
    "inventory": "inventory-control",
    "purchasing": "purchasing-review",
    "finance": "finance-review",
}


class SamplePeopleError(RuntimeError):
    """A safe operator-facing sample identity workflow failure."""


@dataclass(frozen=True, slots=True)
class PersonSpec:
    key: str
    email: str
    username: str
    name: str
    title: str
    role: str
    status: str
    groups: tuple[str, ...] = ()
    actor: str | None = None
    sponsor: str | None = None


@dataclass(frozen=True, slots=True)
class SamplePerson:
    user_id: str
    email: str
    username: str
    role: str
    status: str


@dataclass(frozen=True, slots=True)
class SampleActorCredential:
    user_id: str
    email: str
    password: str


@dataclass(frozen=True, slots=True)
class SamplePeopleResult:
    users: Mapping[str, SamplePerson]
    actors: Mapping[str, SampleActorCredential]
    groups: Mapping[str, str]


_TEAM_ROSTER = TEAM_ROSTER


def _identity(name: str, domain: str = INTERNAL_DOMAIN) -> tuple[str, str]:
    """A natural e-mail address and username for a person's display name."""
    first, *rest = name.lower().split()
    last = "".join(rest)
    return f"{first}.{last}@{domain}", f"{first}_{last}"


def _people() -> tuple[PersonSpec, ...]:
    people: list[PersonSpec] = []
    for team, members in _TEAM_ROSTER.items():
        for index, name in enumerate(members):
            suffix = "lead" if index == 0 else f"{index + 1:02d}"
            actor = team if suffix == "lead" else None
            email, username = _identity(name)
            groups: tuple[str, ...] = (_TEAM_GROUPS[team],)
            if actor:
                groups += ("harbor-operations",)
            if team == "sales" and index in {3, 4}:
                groups += ("internal-audit",)
            people.append(
                PersonSpec(
                    key=f"internal_{team}_{suffix}",
                    email=email,
                    username=username,
                    name=name,
                    title=TEAM_TITLES[team][index],
                    role="member",
                    status="active",
                    groups=groups,
                    actor=actor,
                )
            )

    for index, (team, name, title) in enumerate(
        (
            ("sales", "Taylor James", "Sales Associate"),
            ("service", "Jamie Ortega", "Support Associate"),
            ("inventory", "Robin Lee", "Stock Associate"),
            ("finance", "Alex Perez", "Billing Associate"),
        ),
        start=1,
    ):
        people.append(
            PersonSpec(
                f"internal_pending_{index:02d}",
                *_identity(name),
                name,
                title,
                "member",
                "pending",
                (_TEAM_GROUPS[team],),
            )
        )
    people.extend(
        (
            PersonSpec(
                "internal_disabled_01",
                *_identity("Morgan Ellis"),
                "Morgan Ellis",
                "Former Sales Coordinator",
                "member",
                "disabled",
            ),
            PersonSpec(
                "internal_disabled_02",
                *_identity("Casey Flores"),
                "Casey Flores",
                "Former Field Technician",
                "member",
                "disabled",
            ),
        )
    )
    guest_rows = (
        ("01", "Amara Cole", "Customer Auditor", "active"),
        ("02", "Ben Ito", "Supplier Reviewer", "active"),
        ("03", "Cora Mills", "Project Observer", "active"),
        ("04", "Drew Kim", "Service Partner", "active"),
        ("05", "Eden Park", "External Analyst", "active"),
        ("06", "Finn Blake", "Delivery Partner", "active"),
        ("07", "Gray Patel", "Prospective Partner", "pending"),
        ("08", "Harper Young", "Former External Reviewer", "disabled"),
    )
    for suffix, name, title, state in guest_rows:
        people.append(
            PersonSpec(
                f"guest_{suffix}",
                *_identity(name, GUEST_DOMAINS[int(suffix) % len(GUEST_DOMAINS)]),
                name,
                title,
                "guest",
                state,
                ("guest-readers",),
                sponsor="internal_sales_lead",
            )
        )
    if len(people) != 44:
        raise SamplePeopleError("The people catalogue must contain 44 identities")
    return tuple(people)


_GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    # Department leads: they manage shared views, dashboards and reports everywhere.
    "harbor-operations": tuple((key, None, "manage") for key in _DEPARTMENTS),
    "sales-desk": (("sales", None, "manage"),),
    "service-triage": (("service", None, "manage"),),
    "field-operations": (("field", None, "write"), ("field", "inspections", "manage")),
    "inventory-control": (("inventory", None, "write"), ("inventory", "products", "manage")),
    "purchasing-review": (("purchasing", None, "write"),),
    "finance-review": (("finance", None, "write"),),
    # Two Sales members review Finance and Purchasing records without changing them.
    "internal-audit": (("finance", None, "read"), ("purchasing", None, "read")),
    "guest-readers": tuple((key, None, "manage") for key in _DEPARTMENTS),
}


def _ids(source: Mapping[str, str], keys: tuple[str, ...]) -> dict[str, str]:
    missing = set(keys) - set(source)
    if missing:
        raise SamplePeopleError("Sandbox ID mappings are missing required entries")
    result: dict[str, str] = {}
    for key in keys:
        try:
            result[key] = str(UUID(source[key]))
        except (TypeError, ValueError):
            raise SamplePeopleError(f"Sandbox ID mapping for {key} is not a UUID") from None
    return result


def _data(response: httpx.Response, action: str, expected: int = 200) -> Mapping[str, Any]:
    if response.status_code != expected:
        raise SamplePeopleError(f"{action} failed (HTTP {response.status_code})")
    try:
        payload = response.json()
    except ValueError:
        raise SamplePeopleError(f"{action} returned an invalid API response") from None
    if not isinstance(payload, Mapping):
        raise SamplePeopleError(f"{action} returned an invalid API response")
    return payload


def _write_data(
    roster: CredentialRoster,
    operation: str,
    key: str,
    response: httpx.Response,
    expected: int,
    action: str,
) -> Mapping[str, Any]:
    if response.status_code != expected:
        state = "failed" if 400 <= response.status_code < 500 else "outcome_unknown"
        roster.operation(operation, key, state)
        raise SamplePeopleError(f"{action} {state} (HTTP {response.status_code})")
    if expected == 204:
        roster.operation(operation, key, "completed")
        return {}
    try:
        payload = _data(response, action, expected)
    except SamplePeopleError:
        roster.operation(operation, key, "outcome_unknown")
        raise SamplePeopleError(f"{action} response unusable; outcome unknown") from None
    roster.operation(operation, key, "completed")
    return payload


def _checked_user(
    admin: SampleClient, roster: CredentialRoster, person: PersonSpec, user_id: str, status: str
) -> SamplePerson:
    try:
        payload = _data(admin.request("GET", f"/api/users/{user_id}"), "User readback")
    except (SampleClientError, SamplePeopleError):
        roster.operation("user-readback", person.key, "failed")
        raise
    if any(
        payload.get(field) != expected
        for field, expected in (
            ("id", user_id),
            ("email", person.email),
            ("username", person.username),
            ("role", person.role),
            ("status", status),
        )
    ):
        roster.operation("user-readback", person.key, "failed")
        raise SamplePeopleError(f"User readback did not match {person.key}")
    return SamplePerson(user_id, person.email, person.username, person.role, status)


def _create_groups(
    admin: SampleClient,
    roster: CredentialRoster,
    department_ids: Mapping[str, str],
    module_ids: Mapping[str, str],
) -> dict[str, str]:
    groups: dict[str, str] = {}
    for key, entries in _GROUP_ACCESS.items():
        name = " ".join(word.capitalize() for word in key.split("-"))
        roster.operation("group-create", key, "started")
        created = _write_data(
            roster,
            "group-create",
            key,
            admin.request(
                "POST",
                "/api/access/groups",
                json_body={"name": name},
            ),
            201,
            "Group creation",
        )
        try:
            group_id = str(UUID(created["id"]))
        except (KeyError, TypeError, ValueError):
            roster.operation("group-create", key, "outcome_unknown")
            raise SamplePeopleError("Group creation returned an unusable server ID") from None
        groups[key] = group_id
        roster.set_group(key, group_id=group_id, state="created")
        admin.record_mapping("group", key, group_id)

        current = admin.request("GET", f"/api/access/groups/{group_id}")
        group = _data(current, "Group readback")
        etag = current.headers.get("ETag")
        if not etag or group.get("id") != group_id:
            raise SamplePeopleError("Group access cannot be saved without its current ETag")
        access = [
            {
                "department_id": department_ids[department],
                "module_id": module_ids[module] if module else None,
                "level": level,
            }
            for department, module, level in entries
        ]
        roster.operation("group-access-replace", key, "started")
        response = admin.request(
            "PUT",
            f"/api/access/groups/{group_id}/access",
            json_body={"access": access},
            headers={"If-Match": etag},
        )
        _write_data(roster, "group-access-replace", key, response, 200, "Group access")
        roster.set_group(key, group_id=group_id, state="access_configured")
    return groups


def _invite_body(
    person: PersonSpec,
    group_ids: Mapping[str, str],
    user_ids: Mapping[str, str],
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "email": person.email,
        "username": person.username,
        "display_name": person.name,
        "job_title": person.title,
        "role": person.role,
    }
    if person.groups:
        body["group_ids"] = [group_ids[key] for key in person.groups]
    if person.role == "guest":
        if person.sponsor is None or person.sponsor not in user_ids:
            raise SamplePeopleError("Guest invitation is missing its active member sponsor")
        body["sponsor_user_id"] = user_ids[person.sponsor]
        body["expires_at"] = (datetime.now(UTC) + timedelta(days=90)).isoformat()
    return body


def _new_acceptance_client(api_url: str, origin: str, journal_path: Path) -> SampleClient:
    return SampleClient(api_url, origin, journal_path)


def populate_people(
    admin: SampleClient,
    api_url: str,
    department_ids: Mapping[str, str],
    module_ids: Mapping[str, str],
    mailpit_url: str,
    origin: str,
    roster_path: Path,
) -> SamplePeopleResult:
    """Create 36 internal accounts, eight guests, and the planned access groups."""

    departments = _ids(department_ids, _DEPARTMENTS)
    modules = _ids(module_ids, _MODULES)
    people = _people()
    try:
        roster = CredentialRoster.create(
            roster_path,
            [
                {
                    "key": item.key,
                    "email": item.email,
                    "username": item.username,
                    "display_name": item.name,
                    "job_title": item.title,
                    "role": item.role,
                    "status": item.status,
                }
                for item in people
            ],
        )
    except SampleInvitationError as error:
        raise SamplePeopleError(str(error)) from None
    mailbox = InvitationMailbox(mailpit_url, origin)
    try:
        mailbox.snapshot()
        group_ids = _create_groups(admin, roster, departments, modules)
        users: dict[str, SamplePerson] = {}
        actors: dict[str, SampleActorCredential] = {}
        user_ids: dict[str, str] = {}
        expected_members: dict[str, set[str]] = {key: set() for key in group_ids}

        for person in people:
            baseline = mailbox.snapshot() if person.status != "pending" else set()
            roster.operation("user-invite", person.key, "started")
            invite = admin.request(
                "POST",
                "/api/auth/invitations",
                json_body=_invite_body(person, group_ids, user_ids),
            )
            invited = _write_data(
                roster, "user-invite", person.key, invite, 201, "User invitation"
            ).get("user")
            if not isinstance(invited, Mapping):
                roster.operation("user-invite", person.key, "outcome_unknown")
                raise SamplePeopleError("User invitation returned an unusable profile")
            try:
                user_id = str(UUID(invited.get("id")))
            except (AttributeError, KeyError, TypeError, ValueError):
                roster.operation("user-invite", person.key, "outcome_unknown")
                raise SamplePeopleError("User invitation returned an unusable server ID") from None
            user_ids[person.key] = user_id
            roster.set_account(person.key, state="invited", user_id=user_id)
            for group in person.groups:
                expected_members[group].add(user_id)
            admin.record_mapping("user", person.key, user_id)

            if person.status == "pending":
                users[person.key] = _checked_user(admin, roster, person, user_id, "pending")
                roster.set_account(person.key, state="pending")
                continue

            try:
                token = mailbox.invitation_token(baseline, person.email)
            except SampleInvitationError:
                roster.set_account(person.key, state="email_not_confirmed")
                raise SamplePeopleError(
                    f"No matching invite email for {person.key}; roster retained"
                ) from None
            password = roster.password(person.key)
            roster.operation("invitation-complete", person.key, "started")
            acceptance = _new_acceptance_client(
                api_url,
                origin,
                roster_path.parent / "invitation-requests.jsonl",
            )
            try:
                completed = acceptance.complete_invitation(token, password)
            except SampleWriteOutcomeUnknown:
                roster.operation("invitation-complete", person.key, "outcome_unknown")
                raise SamplePeopleError(
                    f"Completion outcome is unknown for {person.key}; reconcile before rebuilding"
                ) from None
            except SampleClientError:
                roster.operation("invitation-complete", person.key, "failed")
                raise SamplePeopleError(f"Invitation completion failed for {person.key}") from None
            finally:
                acceptance.close()
            _write_data(
                roster,
                "invitation-complete",
                person.key,
                completed,
                204,
                "Invitation completion",
            )
            roster.set_account(person.key, state="active")
            active = _checked_user(admin, roster, person, user_id, "active")
            if person.status == "disabled":
                roster.operation("user-disable", person.key, "started")
                disabled = admin.request(
                    "PATCH",
                    f"/api/users/{user_id}",
                    json_body={"status": "disabled"},
                )
                _write_data(roster, "user-disable", person.key, disabled, 200, "User disable")
                roster.set_account(person.key, state="disabled")
                users[person.key] = _checked_user(admin, roster, person, user_id, "disabled")
            else:
                users[person.key] = active
                if person.role == "member":
                    actors[person.key] = SampleActorCredential(user_id, person.email, password)

        for key, group_id in group_ids.items():
            loaded = _data(admin.request("GET", f"/api/access/groups/{group_id}"), "Group readback")
            if (
                not isinstance(loaded.get("member_ids"), list)
                or set(loaded["member_ids"]) != expected_members[key]
            ):
                raise SamplePeopleError(f"Group membership readback failed for {key}")
        roster.operation("people-verify", "sample-people", "completed")
        return SamplePeopleResult(users=users, actors=actors, groups=group_ids)
    except SampleWriteOutcomeUnknown:
        operation = roster.document["last_operation"]
        roster.operation(
            operation["operation"], operation.get("logical_key", "unknown"), "outcome_unknown"
        )
        raise SamplePeopleError(
            "A sample write has an unknown outcome; reconcile before rebuilding"
        ) from None
    except SampleClientError:
        operation = roster.document["last_operation"]
        if operation.get("state") == "started":
            roster.operation(
                operation["operation"], operation.get("logical_key", "unknown"), "failed"
            )
        raise SamplePeopleError(
            "The sample API request failed; inspect the private run journal"
        ) from None
    finally:
        mailbox.close()
