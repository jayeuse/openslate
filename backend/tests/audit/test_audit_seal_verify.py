"""DBI-10: the verify command reports each changed, removed or added hour (S11, K25, K31).

Two organizations and the installation are sealed from 00:00 to 05:00 on 2001-01-01, then
the owner changes rows or seals, and `operations/verify_audit_seals.py` runs as the runtime.
"""

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import Connection, text
from sqlalchemy.exc import DBAPIError
from uuid6 import uuid7

from app.core.database.organization_scope import apply_connection_scope
from app.systems.manage.audit import seals
from app.systems.manage.audit.seals import CANONICAL_ROW, read_hours, seal_audit
from app.systems.platform.scheduling import worker as worker_module
from operations import verify_audit_seals
from tests.audit.seal_support import DAY, SealWorld, add_audit_row, hour_of, sealed_hours
from tests.audit.seal_support import world as world
from tests.migrations.audit_partition_support import (
    INSUFFICIENT_PRIVILEGE,
    sqlstate,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration

NOW = hour_of(1, 8)
CHECK_VIOLATION = "23514"


@pytest.fixture
def sealed(world: SealWorld) -> SealWorld:
    """Rows in hours 0 and 2 of the first organization, and one row in each other chain."""

    with world.engines.owner.begin() as connection:
        add_audit_row(connection, DAY + timedelta(minutes=10), world.first)
        add_audit_row(connection, DAY + timedelta(minutes=20), world.first)
        add_audit_row(connection, hour_of(1, 2) + timedelta(minutes=5), world.first)
        add_audit_row(connection, hour_of(1, 1) + timedelta(minutes=15), world.second)
        add_audit_row(connection, DAY + timedelta(minutes=40), None)
    assert seal_audit(world.engines.runtime, now=NOW) == seals.SealPass(backlog=False)
    return world


def _verify(
    world: SealWorld, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    *arguments: str,
) -> tuple[int, dict[str, Any]]:
    monkeypatch.setattr(verify_audit_seals, "get_engine", lambda: world.engines.runtime)
    monkeypatch.setattr(verify_audit_seals, "utc_now", lambda: NOW)
    capsys.readouterr()
    exit_code = verify_audit_seals.main(list(arguments))
    # A log line can reach stdout before or after the report, which is the one JSON line.
    lines = capsys.readouterr().out.splitlines()
    [report] = [line for line in lines if line.startswith("{")]
    return exit_code, json.loads(report)


def _owner(world: SealWorld, statement: str, **values: Any) -> None:
    with world.engines.owner.begin() as connection:
        connection.execute(text(statement), values)


def _finding(org_id: UUID | None, hour: int | None, kind: str, sealed: Any = None,
             current: Any = None) -> dict[str, Any]:
    return {
        "org_id": str(org_id) if org_id else None,
        "hour": f"2001-01-01T{hour:02d}:00:00+00:00" if hour is not None else None,
        "kind": kind,
        "sealed_count": sealed,
        "current_count": current,
    }


def test_an_unchanged_installation_verifies_clean(
    sealed: SealWorld, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code, report = _verify(sealed, monkeypatch, capsys)

    assert (exit_code, report["status"], report["findings"]) == (0, "ok", [])
    assert (report["sealed_hours"], report["rows"]) == (18, 5)


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        pytest.param(
            "UPDATE public.audit_logs SET after = '{\"name\": \"changed\"}' "
            "WHERE org_id = :first AND created_at = '2001-01-01 00:10+00'",
            ("changed", 2, 2),
            id="update",
        ),
        pytest.param(
            "DELETE FROM public.audit_logs "
            "WHERE org_id = :first AND created_at = '2001-01-01 00:10+00'",
            ("removed", 2, 1),
            id="delete",
        ),
        pytest.param(
            "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type) "
            "VALUES (gen_random_uuid(), :first, '2001-01-01 00:59:59.999999+00', 'create', "
            "'records')",
            ("added", 2, 3),
            id="insert",
        ),
    ],
)
def test_an_owner_change_of_one_row_is_reported_with_its_organization_hour_and_kind(
    sealed: SealWorld,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    change: str,
    expected: tuple[str, int, int],
) -> None:
    _owner(sealed, change, first=sealed.first)

    exit_code, report = _verify(sealed, monkeypatch, capsys)

    kind, sealed_count, current_count = expected
    assert exit_code == 1
    assert report["findings"] == [_finding(sealed.first, 0, kind, sealed_count, current_count)]


def test_removing_the_latest_seals_is_reported(
    sealed: SealWorld,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    heads = tmp_path / "seal-heads.json"
    assert _verify(sealed, monkeypatch, capsys, "--write-heads", str(heads))[0] == 0
    _owner(
        sealed,
        "DELETE FROM public.audit_seals WHERE org_id = :first AND hour_start >= :hour",
        first=sealed.first, hour=hour_of(1, 3),
    )

    without_heads = _verify(sealed, monkeypatch, capsys)
    with_heads = _verify(sealed, monkeypatch, capsys, "--heads", str(heads))

    # Two hours of slack past the 06:00 horizon, so only 03:00 is late; the head names 05:00.
    assert without_heads == (1, without_heads[1])
    assert without_heads[1]["findings"] == [_finding(sealed.first, 3, "unsealed")]
    assert with_heads[0] == 1
    assert with_heads[1]["findings"] == [
        _finding(sealed.first, 3, "unsealed"),
        _finding(sealed.first, 5, "head_mismatch"),
    ]


def _seal_changes(world: SealWorld) -> dict[str, tuple[Callable[[], None], list[Any]]]:
    first = world.first
    stray = uuid7()
    return {
        "seal_missing": (
            lambda: _owner(
                world, "DELETE FROM public.audit_seals WHERE org_id = :org AND hour_start = :at",
                org=first, at=hour_of(1, 2),
            ),
            [_finding(first, 2, "seal_missing")],
        ),
        "seal_changed": (
            lambda: _owner(
                world,
                "UPDATE public.audit_seals SET chain_hash = sha256('x'::bytea) "
                "WHERE org_id = :org AND hour_start = :at",
                org=first, at=hour_of(1, 1),
            ),
            [_finding(first, 1, "seal_changed", 0), _finding(first, 2, "seal_changed", 1)],
        ),
        "rows_before_chain": (
            lambda: _owner(
                world,
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type) "
                "VALUES (gen_random_uuid(), :org, '2000-12-31 23:30+00', 'create', 'records')",
                org=first,
            ),
            [{**_finding(first, None, "rows_before_chain", None, 1),
              "hour": "2000-12-31T23:00:00+00:00"}],
        ),
        "duplicate_id": (
            lambda: _owner(
                world,
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type) "
                "SELECT id, org_id, '2001-01-01 07:30+00', 'create', 'records' "
                "FROM public.audit_logs WHERE org_id = :org AND created_at = :at",
                org=first, at=DAY + timedelta(minutes=10),
            ),
            [_finding(first, None, "duplicate_id", None, 1)],
        ),
        "chain_absent": (
            lambda: None,
            [_finding(stray, 3, "chain_absent")],
        ),
    }


@pytest.mark.parametrize(
    "kind", ["seal_missing", "seal_changed", "rows_before_chain", "duplicate_id", "chain_absent"]
)
def test_each_other_kind_of_finding(
    sealed: SealWorld,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
    kind: str,
) -> None:
    change, expected = _seal_changes(sealed)[kind]
    change()
    arguments: list[str] = []
    if kind == "chain_absent":
        heads = tmp_path / "removed-organization.json"
        heads.write_text(json.dumps({"heads": [{
            "org_id": expected[0]["org_id"], "hour_start": "2001-01-01T03:00:00+00:00",
            "chain_hash": "00" * 32, "row_count": 0,
        }]}))
        arguments = ["--heads", str(heads)]

    exit_code, report = _verify(sealed, monkeypatch, capsys, *arguments)

    assert (exit_code, report["findings"]) == (1, expected)


def _row_hashes(connection: Connection, world: SealWorld) -> dict[Any, bytes]:
    found = read_hours(connection, world.first, DAY, hour_of(1, 6))
    return {hour: value.rows_hash for hour, value in found.items()}


def test_a_row_gives_the_same_hash_after_a_copy_out_and_in(sealed: SealWorld) -> None:
    # K34: `pg_dump` writes COPY text, and a restore parses it back. QA repeats this with a
    # real dump and restore.
    _owner(
        sealed,
        "UPDATE public.audit_logs SET before = 'null', after = "
        "'{\"name\": \"Ünïcode ✓\", \"amount\": 1.50, \"nested\": [null, true, 2e3]}', "
        "note = E'tab\\there', request_path = '/api/records/1' "
        "WHERE org_id = :first AND created_at = '2001-01-01 00:10+00'",
        first=sealed.first,
    )
    with sealed.engines.owner.connect() as connection:
        before = _row_hashes(connection, sealed)
        cursor = connection.connection.cursor()
        query = "COPY (SELECT * FROM public.audit_logs WHERE org_id = %s) TO STDOUT"
        with cursor.copy(query, (sealed.first,)) as copy:
            data = b"".join(bytes(block) for block in copy)
        cursor.execute("DELETE FROM public.audit_logs WHERE org_id = %s", (sealed.first,))
        with cursor.copy("COPY public.audit_logs FROM STDIN") as copy:
            copy.write(data)
        copied = _row_hashes(connection, sealed)
        cursor.execute("SET TimeZone TO 'Asia/Manila'")
        elsewhere = _row_hashes(connection, sealed)
        connection.commit()

    assert len(before) == 2
    assert copied == before
    assert elsewhere == before


def test_the_row_form_keeps_sql_null_apart_from_json_null(
    sealed: SealWorld,
) -> None:
    columns = (
        "id, org_id, created_at, performed_by, action, entity_type, entity_id, department_id, "
        "before, after, request_id, request_method, request_path, actor_label, note"
    )
    row = (
        "'01a1b5c1-0000-7000-8000-000000000001'::uuid, NULL::uuid, "
        "'2001-01-01 00:10:00.5+00'::timestamptz, NULL::uuid, 'update', 'records', "
        "'01a1b5c1-0000-7000-8000-000000000002'::uuid, NULL::uuid, {before}::jsonb, "
        "'{{\"name\": \"row\"}}'::jsonb, NULL::uuid, NULL, NULL, NULL, NULL"
    )
    with sealed.engines.owner.connect() as connection:
        forms = [
            connection.scalar(
                text(
                    f"SELECT {CANONICAL_ROW} FROM (VALUES ({row.format(before=before)})) "
                    f"AS audit_logs ({columns})"
                )
            )
            for before in ("NULL", "'null'")
        ]

    assert forms == [
        '["01a1b5c1-0000-7000-8000-000000000001", null, "2001-01-01T00:10:00.500000Z", null, '
        '"update", "records", "01a1b5c1-0000-7000-8000-000000000002", null, null, '
        '[{"name": "row"}], null, null, null, null, null]',
        '["01a1b5c1-0000-7000-8000-000000000001", null, "2001-01-01T00:10:00.500000Z", null, '
        '"update", "records", "01a1b5c1-0000-7000-8000-000000000002", null, [null], '
        '[{"name": "row"}], null, null, null, null, null]',
    ]


def test_a_check_that_cannot_read_the_database_exits_2_with_no_detail(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def unreachable() -> None:
        raise OSError("connection refused at a private address")

    monkeypatch.setattr(verify_audit_seals, "get_engine", unreachable)

    exit_code = verify_audit_seals.main([])

    assert (exit_code, capsys.readouterr().out.strip()) == (2, '{"status": "unavailable"}')


WHOLE_HOUR = "(extract(epoch FROM hour_start) % 3600) = 0"
_FORGE = text(
    "INSERT INTO public.audit_seals (id, org_id, hour_start, row_count, rows_hash, chain_hash, "
    "form, sealed_at) VALUES (gen_random_uuid(), :org, :hour, 0, :rows, :chain, 1, now())"
)


def _forged_seal(org_id: UUID, hour: datetime) -> dict[str, Any]:
    """An empty seal with a chain hash that follows from no seal, as a forger would write."""

    empty = hashlib.sha256(b"").digest()
    chain = hashlib.sha256(
        b"slateops-audit-seal-v1" + bytes(32) + org_id.bytes
        + int(hour.timestamp()).to_bytes(8, "big", signed=True) + bytes(8) + empty
    ).digest()
    return {"org": org_id, "hour": hour, "rows": empty, "chain": chain}


def _runtime_refusal(world: SealWorld, forged: dict[str, Any]) -> str:
    with world.engines.runtime.connect() as connection:
        apply_connection_scope(connection, forged["org"])
        with pytest.raises(DBAPIError) as refused:
            connection.execute(_FORGE, forged)
        return str(sqlstate(refused.value))


def _wake(world: SealWorld, monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, Any]]:
    """One worker wake as the runtime at `NOW`; the reason and organization of each log."""

    logger = Mock()
    monkeypatch.setattr(worker_module, "get_engine", lambda: world.engines.runtime)
    monkeypatch.setattr(worker_module, "log_event", logger)
    worker_module.ReportSchedulingWorker(
        SimpleNamespace(environment="test", e2e_background_workers=False)
    ).seal_audit_once(now=NOW)
    return [(call.kwargs["reason_code"], call.kwargs["org_id"]) for call in logger.call_args_list]


def test_a_seal_off_the_whole_hour_is_refused_stops_the_worker_and_is_reported(
    world: SealWorld, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    # Half a second past the chain's first hour: a later hour would never meet it again.
    forged = _forged_seal(world.first, DAY + timedelta(milliseconds=500))
    assert _runtime_refusal(world, forged) == CHECK_VIOLATION

    # Without the CHECK, which only the owner can drop, the worker and verify still refuse it.
    dropped = False
    try:
        with world.engines.owner.begin() as connection:
            connection.execute(
                text("ALTER TABLE public.audit_seals DROP CONSTRAINT ck_audit_seals_whole_hour")
            )
            dropped = True
            connection.execute(_FORGE, forged)
            add_audit_row(connection, hour_of(1, 1) + timedelta(minutes=10), world.first)

        logged = _wake(world, monkeypatch)
        exit_code, report = _verify(world, monkeypatch, capsys)

        assert ("audit_seal_failed", world.first) in logged
        assert list(sealed_hours(world.engines, world.first)) == [forged["hour"]]
        assert exit_code == 1
        assert {
            **_finding(world.first, None, "seal_misaligned", 0),
            "hour": "2001-01-01T00:00:00.500000+00:00",
        } in report["findings"]
        assert _finding(world.first, 1, "unsealed") in report["findings"]
    finally:
        with world.engines.owner.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_seals WHERE org_id = :org"), {"org": world.first}
            )
            if dropped:
                connection.execute(
                    text(
                        "ALTER TABLE public.audit_seals ADD CONSTRAINT ck_audit_seals_whole_hour "
                        f"CHECK ({WHOLE_HOUR})"
                    )
                )


def test_a_future_seal_is_refused_stops_the_worker_and_is_reported(
    world: SealWorld, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    far = datetime(2999, 1, 1, tzinfo=UTC)
    forged = _forged_seal(world.first, far)
    assert _runtime_refusal(world, forged) == INSUFFICIENT_PRIVILEGE

    # The owner is not bound by row-level security; the worker and verify still refuse it.
    with world.engines.owner.begin() as connection:
        connection.execute(_FORGE, forged)

    logged = _wake(world, monkeypatch)
    exit_code, report = _verify(world, monkeypatch, capsys)

    assert ("audit_seal_failed", world.first) in logged
    assert list(sealed_hours(world.engines, world.first)) == [far]
    assert exit_code == 1
    assert {
        **_finding(world.first, None, "seal_in_future", 0), "hour": "2999-01-01T00:00:00+00:00"
    } in report["findings"]
    assert _finding(world.first, 3, "unsealed") in report["findings"]


def test_a_function_in_public_cannot_change_the_row_form(
    sealed: SealWorld,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    heads = tmp_path / "seal-heads.json"
    assert _verify(sealed, monkeypatch, capsys, "--write-heads", str(heads))[0] == 0
    try:
        with sealed.engines.owner.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.audit_logs SET after = '{\"name\": \"tampered\"}' "
                    "WHERE org_id = :first AND created_at = '2001-01-01 00:10+00'"
                ),
                {"first": sealed.first},
            )
            # Gives back the sealed text, so a form that resolves through `public` sees no change.
            connection.execute(
                text(
                    "CREATE FUNCTION public.convert_to(row_text text, encoding text) "
                    "RETURNS bytea LANGUAGE sql AS $$ SELECT pg_catalog.convert_to("
                    "pg_catalog.replace(row_text, '\"tampered\"', '\"row\"'), "
                    "encoding::pg_catalog.name) $$"
                )
            )

        exit_code, report = _verify(sealed, monkeypatch, capsys, "--heads", str(heads))
    finally:
        with sealed.engines.owner.begin() as connection:
            connection.execute(text("DROP FUNCTION IF EXISTS public.convert_to(text, text)"))

    assert (exit_code, report["findings"]) == (1, [_finding(sealed.first, 0, "changed", 2, 2)])


def test_the_row_form_is_the_same_on_a_search_path_that_puts_public_first(
    sealed: SealWorld,
) -> None:
    with sealed.engines.owner.connect() as connection:
        before = _row_hashes(connection, sealed)
        connection.execute(text("SET LOCAL search_path = public, pg_catalog"))
        # The same argument types as the catalog function: on this path it wins unless the
        # form names `pg_catalog`.
        connection.execute(
            text(
                "CREATE FUNCTION public.convert_to(text, pg_catalog.name) RETURNS bytea "
                "LANGUAGE sql AS $$ SELECT '\\x00'::pg_catalog.bytea $$"
            )
        )
        hostile = _row_hashes(connection, sealed)
        connection.rollback()

    assert len(before) == 2
    assert hostile == before


def test_the_seal_job_and_verify_read_rows_on_the_catalog_search_path(
    sealed: SealWorld, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    paths: list[str] = []

    def recording(connection: Connection, *arguments: Any) -> Any:
        paths.append(connection.scalar(text("SELECT pg_catalog.current_setting('search_path')")))
        return read_hours(connection, *arguments)

    monkeypatch.setattr(seals, "read_hours", recording)
    monkeypatch.setattr(verify_audit_seals, "read_hours", recording)
    with sealed.engines.owner.begin() as connection:
        add_audit_row(connection, hour_of(1, 6) + timedelta(minutes=5), sealed.first)

    seals.seal_chain(sealed.engines.runtime, sealed.first, hour_of(1, 9))
    assert _verify(sealed, monkeypatch, capsys)[0] == 0

    assert len(paths) >= 2
    assert set(paths) == {"pg_catalog, pg_temp"}
