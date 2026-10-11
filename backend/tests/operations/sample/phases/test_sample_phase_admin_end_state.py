"""A run leaves no extra administrator, so the guarded reset can clear it."""

from __future__ import annotations

import pytest

from operations.sample.packs.registry import get_pack
from operations.sample.phases.expectations import final_people_pack
from operations.sample.phases.plan import plan_phases
from tests.operations.sample.sample_datasets import sample_dataset


@pytest.mark.parametrize("pack_key", ["harbor", "school"])
def test_promoted_person_returns_to_member_in_their_original_groups(pack_key: str) -> None:
    # The guarded reset refuses while any administrator besides the preserved one exists.
    pack = get_pack(pack_key)
    dataset = sample_dataset(pack=pack_key)
    actions = tuple(plan_phases(dataset))
    promoted = next(action.target_key for action in actions if action.kind == "promote_user")
    final = {person.key: person for person in final_people_pack(pack, actions).actors.people}
    original = {person.key: person for person in pack.actors.people}

    assert [key for key, person in final.items() if person.role == "admin"] == [
        key for key, person in original.items() if person.role == "admin"
    ]
    assert final[promoted].role == "member"
    assert set(final[promoted].groups) == set(original[promoted].groups)
