"""Cold-load Comms reads at Harbor size, with a structural guard on the access relation.

The guard is the plan of the access relation behind presence and bootstrap (the longest
statement of each request): how often it rescans accounts. Wall-clock times are recorded
properties only. Provider-auth latency is not measured (the fixture supplies the
principal). Set ``OPENSLATE_COMMS_LATENCY_CONCURRENCY=1`` to also record 40 concurrent
requests (20 per account) and 10 concurrent presence checks; the default run fires no
bursts beside sibling shards.
"""

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from time import perf_counter
from typing import Annotated

import pytest
from fastapi import Depends
from sqlalchemy import bindparam, event, text

from app.common.dependencies.auth import (
    get_account_user,
    get_current_membership,
    get_current_user,
)
from app.systems.access.users.models import Membership, User
from app.systems.access.users.person_visibility import visible_person_ids
from tests.comms.harbor_scale_support import build_harbor_scale
from tests.comms.routes.structure_support import ROOT
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration

SAMPLES = 10
CONCURRENCY = os.environ.get("OPENSLATE_COMMS_LATENCY_CONCURRENCY") == "1"
GUARDED = ("presence", "bootstrap")
# Before the per-person department clause (run 07b12f6a): max loops 4951 / 2530 and
# 17 / 13 users-table scan nodes (one inside every department-level reader subquery);
# after (run 3e3e8be7): 1446 / 529 and 5 / 1. Loops are bounded only without statistics,
# where the old plan repeats per (conversation, person) pair.
MAX_LOOPS_UNANALYZED = {"presence": 3000, "bootstrap": 1500}
MAX_USERS_SCANS = {"presence": 8, "bootstrap": 3}


def _routes(world):
    people = [str(person.id) for person in world.people]
    return {
        "presence": (ROOT + "/presence", [("user_ids", identity) for identity in people]),
        "search_has_record": (ROOT + "/search", {"has": "record", "limit": 100}),
        "threads": (ROOT + "/threads", {"limit": 100, "archived": "false"}),
        "threads_archived": (ROOT + "/threads", {"limit": 100, "archived": "true"}),
        "bootstrap": (ROOT + "/bootstrap", None),
        "notifications": ("/api/notifications", None),
    }


def _client(case, actor, org):
    """As the inbox tests: the real membership dependency binds every request's org."""
    api = case.client(actor, org)

    def current(
        user: Annotated[User, Depends(get_account_user)],
        membership: Annotated[Membership, Depends(get_current_membership)],
    ) -> User:
        return user

    api.app.dependency_overrides[get_current_user] = current
    return api


@pytest.fixture
def harbor_routes(message_routes):
    case, org = message_routes, message_routes.world.first
    try:
        with case.world.session(org) as db:
            # The test reads the built people's identities after this session closes.
            db.expire_on_commit = False
            admin, peer = db.get(User, org.author), db.get(User, org.peer)
            world = build_harbor_scale(db, org.id, admin, peer)
            db.commit()
        case.world.additional_users.extend(
            person.id for person in world.people if person.id not in (org.author, org.peer)
        )
        yield case, org, world
    finally:
        owned = {"orgs": [org.id]}
        with case.world.owner.begin() as connection:
            for table in ("board_groups", "boards"):
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE org_id IN :orgs").bindparams(
                        bindparam("orgs", expanding=True)
                    ),
                    owned,
                )


def test_cold_load_access_relation_does_not_rescan_accounts_per_pair(
    harbor_routes, record_property,
):
    """Before the tables have statistics (a small installation that autovacuum has not
    analyzed yet) and after ANALYZE."""
    case, org, world = harbor_routes
    routes = _routes(world)
    clients = {
        label: _client(case, world.accounts[label].id, org.id) for label in ("writer", "admin")
    }
    evidence = {"statistics_before": _statistics(case)}
    if CONCURRENCY:
        names = [*routes] * 4
        jobs = [(label, name) for label in ("writer", "admin") for name in names[:20]]
        burst_clients = [_client(case, world.accounts[label].id, org.id) for label, _ in jobs]
        # Harness baseline: the first request of each new test client, on a route without
        # a database read; it also warms those clients for the measured bursts.
        evidence["health_baseline_ms"] = [
            elapsed for _, elapsed in _burst(
                [lambda api=api: api.get("/api/health").status_code for api in burst_clients]
            )
        ]
    for phase in ("unanalyzed", "analyzed"):
        if phase == "analyzed":
            evidence["statistics_after_unanalyzed"] = _statistics(case)
            with case.world.owner.connect() as connection:
                connection.execution_options(isolation_level="AUTOCOMMIT").execute(
                    text("ANALYZE")
                )
        evidence[phase] = _alone(case, org, clients, routes)
        if CONCURRENCY:
            evidence[phase]["concurrent"] = _concurrent(case, routes, jobs, burst_clients)
            evidence[phase]["database_concurrency"] = _database_concurrency(case, org, world)
    _write(evidence)
    shape = {}
    for phase in ("unanalyzed", "analyzed"):
        for key, values in evidence[phase]["reads"].items():
            record_property(f"{phase}:{key}:max_ms", values["max_ms"])
        for name, plan in evidence[phase]["plans"].items():
            shape[f"{phase}:{name}"] = (plan["max_loops"], plan["users_scans"])
    over = {
        key: value for key, value in shape.items()
        if value[1] > MAX_USERS_SCANS[key.split(":")[1]]
        or (key.startswith("unanalyzed:") and value[0] > MAX_LOOPS_UNANALYZED[key.split(":")[1]])
    }
    assert len(shape) == 4 and not over, shape


def _alone(case, org, clients, routes):
    statements = []

    def before(connection, _cursor, _statement, _parameters, _context, _many):
        connection.info["started"] = perf_counter()

    def after(connection, _cursor, statement, parameters, _context, _many):
        statements.append(
            (statement, parameters, (perf_counter() - connection.info["started"]) * 1000)
        )

    result = {"reads": {}, "plans": {}}
    engine = case.world.runtime
    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    try:
        for label, api in clients.items():
            for name, (path, params) in routes.items():
                assert api.get(path, params=params).status_code == 200, (label, name)
                samples, counts, longest, slowest = [], [], None, 0.0
                for _ in range(SAMPLES):
                    statements.clear()
                    started = perf_counter()
                    response = api.get(path, params=params)
                    samples.append((perf_counter() - started) * 1000)
                    assert response.status_code == 200, response.text
                    counts.append(len(statements))
                    longest = longest or max(statements, key=lambda row: len(row[0]))
                    slowest = max(slowest, *(row[2] for row in statements))
                result["reads"][f"{label}:{name}"] = {
                    "max_ms": round(max(samples), 1),
                    "median_ms": round(sorted(samples)[SAMPLES // 2], 1),
                    "statements": sorted(set(counts)), "slowest_statement_ms": round(slowest, 1),
                }
                if label == "writer" and name in GUARDED:
                    result["plans"][name] = _explain(case, org, longest)
    finally:
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
    return result


def _statistics(case):
    tables = (
        "users", "memberships", "groups", "group_members", "group_access", "departments",
        "comms_conversations", "comms_members", "comms_channel_access", "boards",
    )
    with case.world.owner.connect() as connection:
        rows = connection.execute(text(
            "SELECT relname, n_live_tup, last_analyze, last_autoanalyze FROM pg_stat_user_tables"
            " WHERE schemaname = 'public' AND relname IN :tables"
        ).bindparams(bindparam("tables", expanding=True)), {"tables": list(tables)})
        return {row[0]: [row[1], row[2], row[3]] for row in rows}


def _explain(case, org, statement):
    sql, parameters, _ = statement
    with case.world.session(org) as db:
        cursor = db.connection().connection.cursor()
        cursor.execute("EXPLAIN (ANALYZE, BUFFERS) " + sql, parameters)
        plan = [row[0] for row in cursor.fetchall()]
        db.rollback()
    loops = [int(value) for value in re.findall(r"loops=(\d+)", " ".join(plan))]
    users = [line for line in plan if re.search(r" on users( |$)", line)]
    return {
        "sql_chars": len(sql), "max_loops": max(loops), "users_scans": len(users), "plan": plan,
    }


def _burst(calls):
    gate = Barrier(len(calls))

    def run(call):
        gate.wait(timeout=60)
        started = perf_counter()
        status = call()
        return status, round((perf_counter() - started) * 1000, 1)

    with ThreadPoolExecutor(len(calls)) as pool:
        return list(pool.map(run, calls))


def _concurrent(case, routes, jobs, clients):
    """One cold load's worth of reads at once: 40, 20 per account, each read 3 or 4 times."""
    intervals = []

    def before(connection, _cursor, _statement, _parameters, _context, _many):
        connection.info["started"] = perf_counter()

    def after(connection, _cursor, _statement, _parameters, _context, _many):
        intervals.append((connection.info["started"], perf_counter()))

    engine = case.world.runtime
    event.listen(engine, "before_cursor_execute", before)
    event.listen(engine, "after_cursor_execute", after)
    try:
        started = perf_counter()
        results = _burst([
            lambda api=api, route=routes[name]: api.get(route[0], params=route[1]).status_code
            for api, (_, name) in zip(clients, jobs, strict=True)
        ])
        wall = (perf_counter() - started) * 1000
    finally:
        event.remove(engine, "before_cursor_execute", before)
        event.remove(engine, "after_cursor_execute", after)
    summary = {}
    for (label, name), (status, elapsed) in zip(jobs, results, strict=True):
        row = summary.setdefault(f"{label}:{name}", {"ms": [], "statuses": []})
        row["ms"].append(elapsed)
        row["statuses"].append(status)
    return {
        "reads": summary,
        "requests": len(jobs),
        "wall_ms": round(wall, 1),
        "statement_ms_total": round(sum(end - begin for begin, end in intervals) * 1000, 1),
        "statements": len(intervals),
        "load_average": os.getloadavg(),
    }


def _database_concurrency(case, org, world):
    """The presence check alone on as many sessions as the pool holds (5 + 5 overflow)."""
    writer = world.accounts["writer"].id
    candidates = [person.id for person in world.people]
    gate = Barrier(10)

    def run(_index):
        with case.world.session(org) as db:
            actor = db.get(User, writer)
            gate.wait(timeout=60)
            started = perf_counter()
            visible_person_ids(db, actor, candidates)
            return round((perf_counter() - started) * 1000, 1)

    with ThreadPoolExecutor(10) as pool:
        return sorted(pool.map(run, range(10)))


def _write(evidence):
    path = (
        REPOSITORY_ROOT / "backend/test-results/backend-latency"
        / os.environ["OPENSLATE_FULLSTACK_RUN_ID"] / "cold-load.json"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, default=str) + "\n")
