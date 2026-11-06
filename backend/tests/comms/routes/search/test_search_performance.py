"""Thirty searches over 100,000 owned messages; provider-auth latency is not measured."""

import json
import os
import re
from time import perf_counter

import pytest
from sqlalchemy import event, text
from uuid6 import uuid7

from app.systems.comms.messages.models import CommsMessage
from tests.comms.conftest import NOW
from tests.comms.routes.structure_support import ROOT, _ok
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration

SEARCH_INDEX = "ix_comms_messages_body_search"
# A word only the rows below hold. "history" must stay out of them: the seeded total is exact.
SELECTIVE_TERM = "quillwort"
SELECTIVE_ROWS = 50
# 2 x 4,003, the pages read in CI on 5 runs (4,002 locally, and 4,719 beside 120,000 rows of
# another organization). It is this high because row security keeps `@@` from using the search
# index, so even a rare word reads every row of the organization (REQ-0005). When that fix
# lands, this ceiling falls and an assertion that the plan uses the index returns.
SELECTIVE_PAGE_CEILING = 8_006
BROAD_PAGE_FACTOR = 3


def _add_selective_rows(connection, org) -> None:
    connection.execute(CommsMessage.__table__.insert(), [
        {
            "id": uuid7(), "org_id": org.id, "conversation_id": org.conversation,
            "author_id": org.author, "client_key": uuid7(), "seq": 100_000 + position,
            "body": f"Rare {SELECTIVE_TERM} note", "send_fingerprint": "c" * 64,
            "created_at": NOW,
        }
        for position in range(1, SELECTIVE_ROWS + 1)
    ])


def _search_sql(case, api, term: str) -> tuple[dict, list]:
    """One real search, and its count and page statements with their bound parameters."""
    captured = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if "plainto_tsquery" in statement:
            captured.append((statement, parameters))

    event.listen(case.world.runtime, "before_cursor_execute", capture)
    try:
        page = _ok(api.get(ROOT + "/search", params={"q": term, "limit": 50}))
    finally:
        event.remove(case.world.runtime, "before_cursor_execute", capture)
    assert len(captured) == 2, captured
    return page, captured


def _root_plans(case, org, statements) -> list[dict]:
    """Replay captured SQL under the same organization scope; the plan's root nodes."""
    plans = []
    with case.world.session(org) as db:
        cursor = db.connection().connection.cursor()
        cursor.execute("SET LOCAL max_parallel_workers_per_gather = 0")
        for sql, parameters in statements:
            cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, parameters)
            plans.append(cursor.fetchone()[0][0]["Plan"])
        db.rollback()
    return plans


def _pages_read(plan: dict) -> int:
    # Buffers count each page visit, warm or cold, so the number does not depend on the cache.
    return plan["Shared Hit Blocks"] + plan["Shared Read Blocks"]


def _table_and_index_pages(case) -> int:
    with case.world.owner.connect() as connection:
        return connection.scalar(text(
            f"SELECT (pg_relation_size('comms_messages') + pg_relation_size('{SEARCH_INDEX}'))"
            " / current_setting('block_size')::bigint"
        ))


def test_search_over_one_hundred_thousand_messages_is_bounded_and_measured(
    message_routes, monkeypatch, record_property
):
    from app.systems.comms import search as search_module

    case, org = message_routes, message_routes.world.first
    case.seed_large_history()
    with case.world.owner.begin() as connection:
        _add_selective_rows(connection, org)
        connection.execute(text("ANALYZE comms_messages"))
        # A pending list makes the page count depend on how much the last insert left behind.
        connection.execute(text(f"SELECT gin_clean_pending_list('{SEARCH_INDEX}')"))
    handler_samples, baseline_selects, handler_selects, body_rows = [], [], [], []
    active = [False]
    original = search_module.query_messages

    def timed(*args, **kwargs):
        active[0] = True
        started = perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            handler_samples.append((perf_counter() - started) * 1000)
            active[0] = False

    def observe(_connection, cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            (handler_selects if active[0] else baseline_selects).append(statement)
            if re.search(r"\bbody\b", statement):
                body_rows.append(cursor.rowcount)

    monkeypatch.setattr(search_module, "query_messages", timed)
    api = case.client(org.peer, org.id)
    event.listen(case.world.runtime, "after_cursor_execute", observe)
    samples, counts, setup = [], [], []
    try:
        for limit in (2, 100):
            baseline_selects.clear()
            handler_selects.clear()
            page = _ok(api.get(ROOT + "/search", params={"q": "history", "limit": limit}))
            assert page["pagination"]["total"] == 100_000 and page["pagination"]["count"] == limit
            counts.append((len(baseline_selects), len(handler_selects)))
        for _ in range(5):
            started = perf_counter()
            assert (
                api.get(ROOT + "/search", params={"q": "history", "limit": 50}).status_code == 200
            )
            setup.append((perf_counter() - started) * 1000)
        handler_samples.clear()
        for _ in range(30):
            started = perf_counter()
            page = _ok(api.get(ROOT + "/search", params={"q": "history", "limit": 50}))
            samples.append((perf_counter() - started) * 1000)
            assert page["pagination"]["total"] == 100_000 and page["pagination"]["count"] == 50
    finally:
        event.remove(case.world.runtime, "after_cursor_execute", observe)
    assert counts[0] == counts[1] and all(value > 0 for value in counts[0])
    assert body_rows and all(0 <= rows <= 100 for rows in body_rows)
    evidence = {
        "request_ms": samples,
        "handler_ms": handler_samples,
        "warmup_ms": setup,
        "request_p95_ms": sorted(samples)[28],
        "handler_p95_ms": sorted(handler_samples)[28],
        "select_counts_baseline_handler": counts,
        "principal": "Supplied principal; real membership, current policy and PostgreSQL",
        "production_org_baseline_reference": (
            "6 warm or 9 cold SELECTs plus scope; provider-auth latency not measured"
        ),
    }
    # After `evidence`: these requests also pass through `timed`, and must not join its samples.
    selective_page, selective_sql = _search_sql(case, api, SELECTIVE_TERM)
    assert selective_page["pagination"]["total"] == SELECTIVE_ROWS
    selective = _root_plans(case, org, selective_sql)
    _, broad_sql = _search_sql(case, api, "history")
    broad = _root_plans(case, org, broad_sql)
    broad_ceiling = BROAD_PAGE_FACTOR * _table_and_index_pages(case)
    evidence["pages_read"] = {
        "selective_count_and_page": [_pages_read(plan) for plan in selective],
        "broad_count_and_page": [_pages_read(plan) for plan in broad],
        "broad_ceiling": broad_ceiling,
    }
    path = (
        REPOSITORY_ROOT
        / "backend/test-results/s19"
        / os.environ["SLATEOPS_FULLSTACK_RUN_ID"]
        / "search-100000.json"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2) + "\n")
    record_property("search_request_p95_ms", evidence["request_p95_ms"])
    record_property("search_handler_p95_ms", evidence["handler_p95_ms"])
    record_property("search_pages_read", json.dumps(evidence["pages_read"]))
    # Page counts do not depend on runner speed, so they block in every run, CI included.
    for plan in selective:
        assert _pages_read(plan) <= SELECTIVE_PAGE_CEILING, evidence["pages_read"]
    for plan in broad:
        assert _pages_read(plan) <= broad_ceiling, evidence["pages_read"]
        assert plan["Temp Read Blocks"] + plan["Temp Written Blocks"] == 0, plan
    # A shared CI runner reports this wall-clock limit (docs/plans/ci-speed.md B1). Every
    # other run enforces it. The SELECT and row bounds above block in every run.
    if job_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(job_summary, "a", encoding="utf-8") as summary:
            summary.write(f"Search p95: {evidence['request_p95_ms']:.1f} ms (limit 300 ms)\n")
        return
    assert evidence["request_p95_ms"] <= 300, evidence
