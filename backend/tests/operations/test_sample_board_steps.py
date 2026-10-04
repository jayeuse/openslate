"""Board work is planned as small steps by team members, interleaved with records."""

from __future__ import annotations

from collections import Counter

from operations.sample.population.board_steps import BoardMeta, plan_board_steps

TEAM = {
    "sales": tuple(f"internal_sales_{suffix}" for suffix in ("lead", "02", "03", "04", "05")),
    "finance": tuple(f"internal_finance_{suffix}" for suffix in ("lead", "02", "03", "04", "05")),
    "field": tuple(f"internal_field_{suffix}" for suffix in ("lead", "02", "03", "04", "05")),
}
BOARDS = (
    BoardMeta("company", None, "company", ("admin",)),
    BoardMeta("department:sales", "sales", "department", TEAM["sales"]),
    BoardMeta("department:finance", "finance", "department", TEAM["finance"]),
    BoardMeta("department:field", "field", "department", TEAM["field"]),
    BoardMeta("project:sales:customer-renewal", "sales", "project", TEAM["sales"]),
)


def test_each_board_gets_eight_posts_and_twelve_events_once() -> None:
    steps = plan_board_steps(BOARDS)
    kinds = Counter((step.kind, step.board) for step in steps)
    for board in BOARDS:
        assert kinds[("post", board.logical_id)] == 8
        assert kinds[("event", board.logical_id)] == 12
        # Drafts stay drafts; every other post gets one life-cycle step.
        assert kinds[("lifecycle", board.logical_id)] == 6
    assert [step.key for step in steps].count("link:finance-post") == 1
    assert [step.key for step in steps].count("link:field-event") == 1


def test_steps_only_depend_on_earlier_steps_and_name_their_records() -> None:
    steps = plan_board_steps(BOARDS)
    position = {step.key: index for index, step in enumerate(steps)}
    for step in steps:
        assert all(position[need] < position[step.key] for need in step.needs_steps), step.key
    finance = next(step for step in steps if step.key == "link:finance-post")
    assert finance.needs_records == ("invoices:000001", "payments:000001")
    field = next(step for step in steps if step.key == "link:field-event")
    assert field.needs_records == ("equipment:000001", "work_orders:000001")


def test_authors_rotate_within_the_team_and_company_posts_stay_with_admin() -> None:
    steps = plan_board_steps(BOARDS)
    by_board: dict[str, Counter[str]] = {}
    for step in steps:
        by_board.setdefault(step.board, Counter())[step.author_key] += 1
    assert set(by_board["company"]) == {"admin"}
    for board in BOARDS[1:]:
        assert set(by_board[board.logical_id]) <= set(board.authors)
        assert len(by_board[board.logical_id]) >= 4, board.logical_id


def test_life_cycle_and_links_are_done_by_the_post_or_event_author() -> None:
    steps = plan_board_steps(BOARDS)
    authors = {step.key: step.author_key for step in steps}
    for step in steps:
        if step.kind in {"lifecycle", "link"}:
            assert step.author_key == authors[step.needs_steps[0]], step.key


def test_create_steps_from_different_boards_interleave() -> None:
    steps = [step for step in plan_board_steps(BOARDS) if step.kind in {"post", "event"}]
    first_twenty = {step.board for step in steps[:20]}
    assert len(first_twenty) == len(BOARDS)
