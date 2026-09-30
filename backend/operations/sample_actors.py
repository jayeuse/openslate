"""Who creates and owns each generated record: short sessions by a department's team."""

from __future__ import annotations

import random

from operations.sample_vocabulary import TEAM_ROSTER

# People keys per department: the lead first, then the four team members.
TEAM_KEYS: dict[str, tuple[str, ...]] = {
    team: (f"internal_{team}_lead", *(f"internal_{team}_{index:02d}" for index in range(2, 6)))
    for team in TEAM_ROSTER
}
# Leads enter less data than their team, so they are drawn less often.
_LEAD_WEIGHT, _MEMBER_WEIGHT = 1, 3
_SESSION_SIZES = (2, 3, 4, 5, 6)


def department_lead(department: str) -> str:
    return TEAM_KEYS[department][0]


def _weights(department: str) -> list[int]:
    return [_LEAD_WEIGHT] + [_MEMBER_WEIGHT] * (len(TEAM_KEYS[department]) - 1)


def creator_keys(module_key: str, department: str, count: int, seed: int) -> tuple[str, ...]:
    """One creator per record, grouped into sessions of two to six consecutive records.

    Consecutive sessions never have the same person, so each run of one creator is
    exactly one session.
    """
    rng = random.Random(f"{seed}:creators:{module_key}")
    team = TEAM_KEYS[department]
    creators: list[str] = []
    previous: str | None = None
    while len(creators) < count:
        choices = [key for key in team if key != previous]
        weights = [
            weight
            for key, weight in zip(team, _weights(department), strict=True)
            if key != previous
        ]
        person = rng.choices(choices, weights=weights)[0]
        creators.extend([person] * rng.choice(_SESSION_SIZES))
        previous = person
    return tuple(creators[:count])


def assignee_key(module_key: str, department: str, index: int, seed: int) -> str:
    rng = random.Random(f"{seed}:assignee:{module_key}:{index}")
    return rng.choices(TEAM_KEYS[department], weights=_weights(department))[0]
