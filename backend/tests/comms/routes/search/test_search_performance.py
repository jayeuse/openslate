"""Thirty searches over 100,000 owned messages; provider-auth latency is not measured."""

import json
import os
import re
from time import perf_counter

import pytest
from sqlalchemy import event, text

from tests.comms.routes.structure_support import ROOT, _ok
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration


def test_search_over_one_hundred_thousand_messages_is_bounded_and_measured(
    message_routes, monkeypatch, record_property
):
    from app.systems.comms import search as search_module

    case, org = message_routes, message_routes.world.first
    case.seed_large_history()
    with case.world.owner.begin() as connection:
        connection.execute(text("ANALYZE comms_messages"))
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
    path = (
        REPOSITORY_ROOT
        / "backend/test-results/s19"
        / os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
        / "search-100000.json"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2) + "\n")
    record_property("search_request_p95_ms", evidence["request_p95_ms"])
    record_property("search_handler_p95_ms", evidence["handler_p95_ms"])
    assert evidence["request_p95_ms"] <= 300, evidence
