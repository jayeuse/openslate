"""Independent runtime HTTP sessions prove source contention and reference serialization."""

import pytest
from sqlalchemy import event, text

from tests.charts.widget_reference_support import reference_race_world as reference_race_world
from tests.race_support import WAIT, StatementPause, join, start, wait_until_blocked_by

pytestmark = pytest.mark.integration


def _archive(world, client):
    return client.delete(f"/api/charts/{world.charts[0]}?revision=1")


@pytest.mark.parametrize("kind", ["board", "dashboard"])
def test_attachment_wins_then_archive_observes_committed_reference(reference_race_world, kind):
    world = reference_race_world
    pause = StatementPause(
        world.runtime,
        "INSERT INTO " + ("board_widgets" if kind == "board" else "dashboard_widgets"),
    )
    with world.client("member") as writer, world.client("admin") as archiver:
        first, first_results = start(lambda: world.attachment(writer, kind))
        second = None
        try:
            assert pause.paused.wait(WAIT)
            second, second_results = start(lambda: _archive(world, archiver))
            wait_until_blocked_by(world.owner, pause.holder_pid)
        finally:
            pause.release.set()
            attached = join(first, first_results)
            archived = join(second, second_results) if second is not None else None
            pause.remove()
    assert attached.status_code == (201 if kind == "board" else 200)
    assert archived is not None and archived.status_code == 409
    assert archived.json()["detail"]["code"] == "chart_in_use"


@pytest.mark.parametrize("kind", ["board", "dashboard"])
def test_archive_wins_attachment_busy_then_committed_archive_is_invalid(reference_race_world, kind):
    world = reference_race_world
    pause = StatementPause(world.runtime, "UPDATE charts")
    with world.client("admin") as archiver, world.client("member") as writer:
        first, results = start(lambda: _archive(world, archiver))
        try:
            assert pause.paused.wait(WAIT)
            busy = world.attachment(writer, kind)
            assert busy.status_code == 503
            assert busy.headers["cache-control"] == "private, no-store"
            assert "First" not in busy.text and "SELECT" not in busy.text
        finally:
            pause.release.set()
            archived = join(first, results)
            pause.remove()
        assert archived.status_code == 204
        committed = world.attachment(writer, kind)
        assert committed.status_code == 409
    table = "board_widgets" if kind == "board" else "dashboard_widgets"
    with world.owner.connect() as observer:
        assert (
            observer.scalar(
                text(f"SELECT count(*) FROM {table} WHERE chart_id = :id"), {"id": world.charts[0]}
            )
            == 0
        )


@pytest.mark.parametrize("held", ["module", "chart", "board", "dashboard", "widget"])
def test_nowait_busy_refusal_releases_earlier_locks_without_partial_writes(
    reference_race_world, held
):
    world = reference_race_world
    table, identifier = {
        "module": ("modules", world.module_id),
        "chart": ("charts", world.charts[0]),
        "board": ("boards", world.board_id),
        "dashboard": ("dashboards", world.dashboard_id),
        "widget": ("board_widgets", None),
    }[held]
    with world.client("member") as client:
        revision = 1
        if held == "widget":
            created = world.attachment(client)
            assert created.status_code == 201
            identifier = created.json()["widget"]["id"]
            revision = 2
        with world.owner.connect() as holder:
            transaction = holder.begin()
            holder.execute(
                text(f"SELECT id FROM {table} WHERE id = :id FOR UPDATE"), {"id": identifier}
            )
            if held == "widget":
                refused = client.patch(
                    f"/api/boards/{world.board_id}/widgets/{identifier}",
                    json={
                        "revision": revision,
                        "widget": {
                            "name": "Changed",
                            "widget_type": "chart",
                            "module_id": str(world.module_id),
                            "chart_id": str(world.charts[0]),
                            "config": None,
                            "size": "L",
                            "pinned": False,
                        },
                    },
                )
            else:
                refused = world.attachment(client, "dashboard" if held == "dashboard" else "board")
            assert refused.status_code == 503
            # Probe all earlier locks while the external holder still owns its one row.
            with world.owner.begin() as observer:
                probes = [
                    ("groups", world.group_id),
                    ("users", world.actors["member"]),
                    ("identity_sessions", world.sessions["member"]),
                    ("modules", world.module_id),
                    ("charts", world.charts[0]),
                    ("boards", world.board_id),
                    ("dashboards", world.dashboard_id),
                ]
                for probe_table, probe_id in probes:
                    if probe_table != table:
                        observer.execute(
                            text(f"SELECT id FROM {probe_table} WHERE id = :id FOR UPDATE NOWAIT"),
                            {"id": probe_id},
                        )
            transaction.rollback()
        with world.owner.connect() as observer:
            parent = "dashboards" if held == "dashboard" else "boards"
            parent_id = world.dashboard_id if held == "dashboard" else world.board_id
            assert (
                observer.scalar(
                    text(f"SELECT revision FROM {parent} WHERE id = :id"), {"id": parent_id}
                )
                == revision
            )
            assert observer.scalar(
                text("SELECT count(*) FROM board_widgets WHERE board_id = :id"),
                {"id": world.board_id},
            ) == (1 if held == "widget" else 0)
            if held == "widget":
                assert (
                    observer.scalar(
                        text("SELECT size FROM board_widgets WHERE id = :id"), {"id": identifier}
                    )
                    == "S"
                )


def test_source_nowait_breaks_publication_and_board_group_reverse_edges(reference_race_world):
    world = reference_race_world
    # B2 owns Group locks, but pauses before its first Department lock.
    pause = StatementPause(world.runtime, "SELECT departments")
    with world.client("member") as writer, world.client("admin") as group_writer:
        attachment, attached_results = start(lambda: world.attachment(writer))
        groups = publication = None
        try:
            assert pause.paused.wait(WAIT)
            groups, groups_results = start(
                lambda: group_writer.put(
                    f"/api/boards/{world.board_id}/groups",
                    json={
                        "revision": 1,
                        "groups": [{"group_id": str(world.group_id), "level": "manage"}],
                    },
                )
            )
            group_pid = wait_until_blocked_by(world.owner, pause.holder_pid)

            def publication_lock_order():
                # Literal owned fixture reproduces executor Department→Module→Field→Board.
                # This is lock-boundary evidence, not C publication/move acceptance.
                with world.owner.begin() as database:
                    for table, identifier in (
                        ("departments", world.department_id),
                        ("modules", world.module_id),
                        ("fields", world.field_id),
                        ("boards", world.board_id),
                    ):
                        database.execute(
                            text(f"SELECT id FROM {table} WHERE id = :id FOR UPDATE"),
                            {"id": identifier},
                        )
                return True

            publication, published_results = start(publication_lock_order)
            wait_until_blocked_by(world.owner, group_pid)
        finally:
            pause.release.set()
            attachment.join(WAIT)
            if groups is not None:
                groups.join(WAIT)
            if publication is not None:
                publication.join(WAIT)
            pause.remove()
        refused = join(attachment, attached_results)
        replaced = join(groups, groups_results)
        assert join(publication, published_results) is True
    assert refused.status_code == 503 and replaced.status_code == 200
    with world.owner.connect() as observer:
        assert (
            observer.scalar(
                text("SELECT revision FROM boards WHERE id = :id"), {"id": world.board_id}
            )
            == 1
        )
        assert (
            observer.scalar(
                text("SELECT count(*) FROM board_widgets WHERE board_id = :id"),
                {"id": world.board_id},
            )
            == 0
        )


def test_module_move_after_unlocked_discovery_refuses_the_source(reference_race_world):
    world = reference_race_world
    pause = StatementPause(world.runtime, "SELECT departments")
    with world.client("member") as client:
        request, results = start(lambda: world.attachment(client))
        try:
            assert pause.paused.wait(WAIT)
            with world.owner.begin() as fixture:
                fixture.execute(
                    text("UPDATE modules SET department_id = :department WHERE id = :id"),
                    {"department": world.other_department_id, "id": world.module_id},
                )
        finally:
            pause.release.set()
            request.join(WAIT)
            pause.remove()
        refused = join(request, results)
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "widget_invalid"
    with world.owner.connect() as observer:
        assert (
            observer.scalar(
                text("SELECT count(*) FROM board_widgets WHERE board_id = :id"),
                {"id": world.board_id},
            )
            == 0
        )
        assert (
            observer.scalar(
                text("SELECT revision FROM boards WHERE id = :id"), {"id": world.board_id}
            )
            == 1
        )


def test_opposite_widget_order_uses_the_same_current_chart_lock_order(reference_race_world):
    world = reference_race_world
    acquired = []

    def observe(_connection, _cursor, statement, parameters, *_args):
        if (
            statement.upper().startswith("SELECT CHARTS.")
            and "FOR UPDATE NOWAIT" in statement.upper()
        ):
            acquired.append(str(parameters["id_1"]))

    event.listen(world.runtime, "before_cursor_execute", observe)
    try:
        with world.client("member") as client:
            created = world.attachment(client, "dashboard", list(reversed(world.charts)))
            assert created.status_code == 200 and created.json()["revision"] == 2
            first = acquired[:]
            acquired.clear()
            changed = client.patch(
                f"/api/dashboards/{world.dashboard_id}",
                json={
                    "revision": 2,
                    "widgets": [
                        {
                            "widget_type": "chart",
                            "chart_id": str(identifier),
                            "config": None,
                            "grid_column": 2 * (index % 2),
                            "grid_row": 2 * (index // 2),
                            "column_span": 2,
                            "row_span": 2,
                        }
                        for index, identifier in enumerate(world.charts)
                    ],
                },
            )
            assert changed.status_code == 200 and changed.json()["revision"] == 3
            expected = [str(identifier) for identifier in sorted(world.charts)]
            assert first == acquired == expected
    finally:
        event.remove(world.runtime, "before_cursor_execute", observe)
