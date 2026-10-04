"""Choose the people who create, own and update generated records."""

from __future__ import annotations

import random
from typing import TYPE_CHECKING, Any

from operations.sample.packs import default_pack
from operations.sample.packs.interface import OrganizationPack

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleRecord


def _pack(organization: OrganizationPack | None) -> OrganizationPack:
    return organization or default_pack()


def department_lead(department: str, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).actors.team_keys[department][0]


_LEVELS = {"read": 1, "write": 2, "manage": 3}


def planned_access_level(
    organization: OrganizationPack, person_key: str, department: str, module_key: str | None
) -> int:
    """Resolve the authored grants for planning; API authorization remains authoritative."""
    person = next((item for item in organization.actors.people if item.key == person_key), None)
    if person is None or person.status != "active":
        return 0
    if person.role == "admin":
        return 3
    best = 0
    for group in person.groups:
        rows = organization.actors.group_access.get(group, ())
        specific = [
            level
            for dept, module, level in rows
            if dept == department and module_key is not None and module == module_key
        ]
        general = [level for dept, module, level in rows if dept == department and module is None]
        chosen = specific or general
        if chosen:
            best = max(best, max(_LEVELS.get(level, 0) for level in chosen))
    return min(best, 1) if person.role == "guest" else best


def writer_keys(
    module_key: str, department: str, organization: OrganizationPack
) -> tuple[str, ...]:
    writers = tuple(
        key
        for key in organization.actors.team_keys[department]
        if planned_access_level(organization, key, department, module_key) >= 2
    )
    if not writers:
        raise ValueError(f"No active module writer for {module_key}")
    return writers


def writer_weights(
    team: tuple[str, ...], department: str, organization: OrganizationPack
) -> list[int]:
    lead = organization.actors.team_keys[department][0]
    return [
        organization.actors.lead_weight if key == lead else organization.actors.member_weight
        for key in team
    ]


def edge_creator_key(
    source: SampleRecord,
    target: SampleRecord,
    organization: OrganizationPack,
    *,
    child: str = "target",
) -> str:
    """Prefer the child creator, then an eligible source writer, without an admin fallback."""
    members = {
        person.key
        for person in organization.actors.people
        if person.status == "active" and person.role == "member"
    }
    child_record = source if child == "source" else target
    candidates = dict.fromkeys(
        (
            child_record.creator_key,
            source.creator_key,
            *organization.actors.team_keys[source.actor_key],
        )
    )
    for key in candidates:
        if (
            key in members
            and planned_access_level(organization, key, source.actor_key, source.module_key) >= 2
            and planned_access_level(organization, key, target.actor_key, target.module_key) >= 1
        ):
            return key
    raise ValueError(f"No active relationship writer for {source.module_key}->{target.module_key}")


def creator_keys(
    module_key: str,
    department: str,
    count: int,
    seed: int,
    organization: OrganizationPack | None = None,
) -> tuple[str, ...]:
    """Assign each record to a person in short consecutive sessions."""
    pack = _pack(organization)
    rng = random.Random(f"{seed}:creators:{module_key}")
    team = writer_keys(module_key, department, pack)
    creators: list[str] = []
    previous: str | None = None
    while len(creators) < count:
        choices = [key for key in team if key != previous or len(team) == 1]
        weights = [
            weight
            for key, weight in zip(team, writer_weights(team, department, pack), strict=True)
            if key != previous or len(team) == 1
        ]
        person = rng.choices(choices, weights=weights)[0]
        creators.extend([person] * rng.choice(pack.actors.session_sizes))
        previous = person
    return tuple(creators[:count])


def assignee_key(
    module_key: str,
    department: str,
    index: int,
    seed: int,
    organization: OrganizationPack | None = None,
) -> str:
    pack = _pack(organization)
    rng = random.Random(f"{seed}:assignee:{module_key}:{index}")
    team = writer_keys(module_key, department, pack)
    return rng.choices(team, weights=writer_weights(team, department, pack))[0]


def __getattr__(name: str) -> Any:
    if name == "TEAM_KEYS":
        return default_pack().actors.team_keys
    raise AttributeError(name)
