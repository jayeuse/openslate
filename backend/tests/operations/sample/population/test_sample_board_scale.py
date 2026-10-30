"""Posts and events per Board grow with the profile (spec R9)."""

from collections import Counter

import pytest

from operations.sample.board_text import post_text
from operations.sample.packs.registry import get_pack
from operations.sample.population.board_steps import BoardMeta, plan_board_steps, post_state

BOARDS = [
    BoardMeta("department:sales", "sales", "department", ("writer",)),
    BoardMeta("company", None, "company", ("writer",)),
]


@pytest.mark.parametrize(("profile", "scale"), [("small", 1), ("standard", 2), ("large", 6)])
def test_posts_and_events_per_board_follow_the_profile(profile: str, scale: int) -> None:
    pack = get_pack("harbor")
    spec = pack.content.data
    steps = plan_board_steps(BOARDS, organization=pack, profile=profile)
    kinds = Counter((step.kind, step.board) for step in steps)

    for board in BOARDS:
        assert kinds[("post", board.logical_id)] == spec.posts_per_board * scale
        assert kinds[("event", board.logical_id)] == spec.events_per_board * scale


def test_later_posts_are_written_from_the_departments_work_and_mostly_published() -> None:
    pack = get_pack("harbor")
    spec = pack.content.data
    board = {"department_key": "sales", "scope": "department"}
    later = [post_text(board, index, 0, 0, organization=pack) for index in range(8, 48)]
    states = Counter(post_state(spec, index) for index in range(8, 48))

    assert all(title and body and len(title) <= 100 for title, body in later)
    assert len({title for title, _ in later}) >= 30
    assert states["published"] > 2 * states["archived"] > 0 and "draft" not in states
    assert [post_state(spec, index) for index in range(8)] == [
        spec.post_states[index // 2] for index in range(8)
    ]
