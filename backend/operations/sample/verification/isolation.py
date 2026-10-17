"""People of one sample organization cannot read another sample organization's data."""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx

from operations.sample.client import SampleClient
from operations.sample.organization import sample_slug
from operations.sample.packs.registry import pack_keys

_REFUSED = frozenset({403, 404})
_MEMBER_ATTEMPTS = 3


def _object(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def roster_logins(roster_path: Path, keys: Iterable[str]) -> list[tuple[str, str]]:
    """Email and password of the named people from the private run roster."""
    wanted = set(keys)
    try:
        accounts = json.loads(roster_path.read_text(encoding="utf-8"))["accounts"]
        return [
            (row["email"], row["password"])
            for row in sorted(accounts, key=lambda row: str(row.get("key")))
            if row.get("key") in wanted
            and isinstance(row.get("email"), str)
            and isinstance(row.get("password"), str)
        ]
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []


def verify_isolation(
    admin: SampleClient,
    *,
    organization_id: str | None,
    api_url: str,
    origin: str,
    journal: Path,
    admin_login: tuple[str, str],
    member_logins: Sequence[tuple[str, str]],
) -> tuple[dict[str, int], list[str]]:
    """Probe one record of every other sample organization the administrator runs.

    The administrator and a member of this organization must not read it here, and
    the member must be refused when it names the other organization.
    """
    own = organization_id
    if own is None:
        return {}, []  # A run from before one organization per pack.
    discovery = admin.request("GET", "/api/auth/me")
    memberships = _object(discovery).get("memberships")
    observed = {"isolation_organizations": 0, "isolation_refusals": 0}
    if discovery.status_code != 200 or not isinstance(memberships, list):
        return observed, ["isolation: peer organization discovery failed"]
    try:
        for row in memberships:
            if not isinstance(row, dict) or not isinstance(row.get("slug"), str) or not row["slug"]:
                raise ValueError("Invalid membership")
            UUID(str(row["org_id"]))
    except (ValueError, KeyError, TypeError):
        return observed, ["isolation: peer organization discovery failed"]
    slugs = {sample_slug(key) for key in pack_keys()}
    others = sorted(
        {
            str(row.get("org_id"))
            for row in memberships
            if row["slug"] in slugs
        }
        - {own}
    )
    observed["isolation_organizations"] = len(others)
    if not others:
        return observed, []
    issues: list[str] = []
    with ExitStack() as stack:

        def signed_in(organization: str, login: tuple[str, str]) -> SampleClient | None:
            client = stack.enter_context(SampleClient(api_url, origin, journal, organization))
            if client.login(*login).status_code != 200:
                return None
            stack.callback(client.request, "POST", "/api/auth/logout")
            return client

        def admitted(client: SampleClient | None) -> bool:
            current = (
                _object(client.request("GET", "/api/auth/me")).get("current_organization")
                if client is not None
                else None
            )
            return isinstance(current, dict) and current.get("org_id") == own

        member, member_login = None, None
        for login in member_logins[:_MEMBER_ATTEMPTS]:
            if admitted(candidate := signed_in(own, login)):
                member, member_login = candidate, login
                break
        if member is None or member_login is None:
            return observed, ["isolation: no active sample member could sign in"]
        for other in others:
            reader = signed_in(other, admin_login)
            probe = (
                _object(reader.request("GET", "/api/records", params={"limit": 1}))
                if reader is not None
                else {}
            )
            try:
                row = probe["items"][0]
                record_id, module_id = str(UUID(str(row["id"]))), str(UUID(str(row["module_id"])))
            except (TypeError, KeyError, IndexError, ValueError):
                issues.append("isolation: another sample organization has no readable record")
                continue
            # The member names the other organization itself; membership must refuse it.
            intruder = signed_in(other, member_login)
            if intruder is None:
                issues.append("isolation: the member could not sign in for the cross probe")
                continue
            refusals = (
                admin.request("GET", f"/api/records/{record_id}").status_code in _REFUSED,
                _object(
                    admin.request("GET", "/api/records", params={"module_id": module_id})
                ).get("items") == [],
                member.request("GET", f"/api/records/{record_id}").status_code in _REFUSED,
                member.request("GET", f"/api/modules/{module_id}").status_code in _REFUSED,
                intruder.request("GET", f"/api/records/{record_id}").status_code in _REFUSED,
            )
            observed["isolation_refusals"] += sum(refusals)
            if not all(refusals):
                issues.append("isolation: another sample organization's data was readable")
    return observed, issues
