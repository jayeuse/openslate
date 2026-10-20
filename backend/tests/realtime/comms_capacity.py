"""S02's 20-topic workload at the assigned 300 target, with real grants/API publication."""

import asyncio
import json
import os
import ssl
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from websockets.asyncio.client import connect

from tests.realtime.capacity_support import Metrics, distribution, machine
from tests.realtime.native_support import native_room as native_room
from tests.repository import REPOSITORY_ROOT

pytestmark = pytest.mark.integration


class LocalConnect(connect):
    def process_redirect(self, exc):
        return exc


class JoinPacer:
    """One scheduled admission permit; unused permits never accumulate into a burst."""

    def __init__(self, per_second):
        self.loop = asyncio.get_running_loop()
        self.interval = 1 / per_second
        self.permits = asyncio.Queue(maxsize=1)
        self.handle = self.loop.call_soon(self.tick)

    def tick(self):
        if self.permits.empty():
            self.permits.put_nowait(None)
        self.handle = self.loop.call_later(self.interval, self.tick)

    async def acquire(self):
        await self.permits.get()

    def close(self):
        self.handle.cancel()


async def cohort(room, count, metrics, result, save):
    value = {
        "attempted": count,
        "topics_per_socket": 20,
        "join_concurrency": 10,
        "join_pacing_per_second": 50,
        "authentication_concurrency": 1,
        "idle_seconds": 60,
        "burst_messages": 30,
        "opened": 0,
        "fully_joined": 0,
        "joined_topics": 0,
        "join_refusals": 0,
        "http_statuses": {},
        "handshake_refusals": {},
        "errors": {},
        "disconnections": 0,
    }
    result["cohorts"].append(value)
    statuses, route_statuses, handshakes, errors = Counter(), Counter(), Counter(), Counter()
    sockets, tasks, headers, expiries, waits = [], [], {}, [], []
    received = {}
    control_events = {"structure": set(), "grants": set()}
    changed = asyncio.Condition()
    slots, authentication = asyncio.Semaphore(10), asyncio.Lock()
    pace, shutdown = JoinPacer(50), asyncio.Event()
    closing = False
    main_task = asyncio.current_task()
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.check_hostname, tls.verify_mode = False, ssl.CERT_NONE

    async with httpx.AsyncClient(
        base_url="http://127.0.0.1:8008", timeout=15, trust_env=False
    ) as api:

        async def watch_machine():
            high_since = None
            while not closing:
                try:
                    await asyncio.wait_for(shutdown.wait(), 5)
                    return
                except TimeoutError:
                    pass
                try:
                    observation = await asyncio.to_thread(machine)
                except Exception:
                    result["global_stop"] = "machine metric unavailable"
                    save()
                    shutdown.set()
                    main_task.cancel()
                    return
                result["machine"].append(observation)
                high_since = (high_since or observation["at"]) if observation["load1"] > 4 else None
                if observation["ram_headroom_percent"] < 20 or (
                    high_since is not None and observation["at"] - high_since >= 30
                ):
                    result["global_stop"] = "S02 headroom/load guard"
                    save()
                    shutdown.set()
                    main_task.cancel()
                    return

        tasks.append(asyncio.create_task(watch_machine()))

        async def call(method, path, **kwargs):
            response = await api.request(method, path, **kwargs)
            statuses[str(response.status_code)] += 1
            route = "/api/comms/conversations/{id}/messages" if path.endswith("/messages") else path
            route_statuses[f"{method} {route} {response.status_code}"] += 1
            return response

        async def login(index):
            person = room.people[index]
            async with authentication:
                response = await call(
                    "POST",
                    "/api/auth/token",
                    json={"email": person.email, "password": person.password},
                )
            if response.status_code != 200:
                raise RuntimeError("API sign-in refused")
            headers[index] = {
                "Authorization": "Bearer " + response.json()["access_token"],
                "X-Org": str(room.org),
            }

        async def presence(index):
            while True:
                # Defined workload cadence, interruptible immediately by the stop condition.
                try:
                    await asyncio.wait_for(shutdown.wait(), 60)
                    return
                except TimeoutError:
                    pass
                try:
                    # Existing clients' heartbeats do not queue behind new socket admission.
                    await login(index)  # Disposable provider tokens expire after 45 seconds.
                    reply = await call(
                        "POST",
                        "/api/comms/presence",
                        headers=headers[index],
                        json={"state": "online"},
                    )
                    if reply.status_code != 200:
                        errors["presence_refused"] += 1
                except Exception as exc:
                    errors[type(exc).__name__] += 1

        async def heartbeat(ws):
            while True:
                try:
                    await asyncio.wait_for(shutdown.wait(), 20)
                    return
                except TimeoutError:
                    pass
                await ws.send(
                    json.dumps(
                        {
                            "topic": "phoenix",
                            "event": "heartbeat",
                            "ref": "heartbeat",
                            "payload": {},
                        }
                    )
                )

        async def read(ws, index):
            try:
                async for raw in ws:
                    message = json.loads(raw)
                    data = message.get("payload", {})
                    if message.get("event") == "broadcast" and data.get("event") in control_events:
                        if data.get("payload") != {}:
                            errors["control_payload_not_empty"] += 1
                        control_events[data["event"]].add(index)
                        async with changed:
                            changed.notify_all()
                    if (
                        message.get("event") == "broadcast"
                        and data.get("event") == "message"
                        and data.get("payload", {}).get("kind") == "created"
                    ):
                        received.setdefault((index, data["payload"]["seq"]), []).append(
                            time.perf_counter_ns()
                        )
                        async with changed:
                            changed.notify_all()
            finally:
                if not closing:
                    value["disconnections"] += 1

        async def admit(index):
            async with slots:
                try:
                    await login(index)
                    response = await call("POST", "/api/realtime/token", headers=headers[index])
                    if response.status_code != 200:
                        raise RuntimeError("Channel token refused")
                    token = response.json()
                    assert set(token["conversation_topics"]) == {
                        f"org:{room.org}:conversation:{i}" for i in room.conversations
                    }
                    expiries.append(
                        datetime.fromisoformat(
                            token["expires_at"].replace("Z", "+00:00")
                        ).timestamp()
                    )
                    ws = await LocalConnect(
                        "wss://localhost:3448/realtime/v1/websocket?vsn=1.0.0",
                        origin="https://localhost:3448",
                        ssl=tls,
                        proxy=None,
                        open_timeout=10,
                        close_timeout=3,
                        max_queue=128,
                    )
                    sockets.append(ws)
                    value["opened"] += 1
                    tasks.append(asyncio.create_task(heartbeat(ws)))
                    topics = [
                        *token["conversation_topics"],
                        f"org:{room.org}:user:{room.people[index].id}",
                        f"org:{room.org}:presence",
                    ]
                    joined = 0
                    for ref, topic in enumerate(topics, 1):
                        await pace.acquire()
                        started = time.perf_counter_ns()
                        await ws.send(
                            json.dumps(
                                {
                                    "topic": "realtime:" + topic,
                                    "event": "phx_join",
                                    "ref": str(ref),
                                    "join_ref": str(ref),
                                    "payload": {
                                        "access_token": token["access_token"],
                                        "config": {
                                            "private": True,
                                            "broadcast": {"self": True, "ack": True},
                                            "presence": {"key": ""},
                                        },
                                    },
                                }
                            )
                        )
                        async with asyncio.timeout(10):
                            while True:
                                message = json.loads(await ws.recv())
                                if message.get("event") == "phx_reply" and message.get(
                                    "ref"
                                ) == str(ref):
                                    break
                        waits.append((time.perf_counter_ns() - started) / 1e6)
                        if message["payload"]["status"] == "ok":
                            joined += 1
                        else:
                            value["join_refusals"] += 1
                    value["joined_topics"] += joined
                    value["fully_joined"] += joined == 20
                    tasks.append(asyncio.create_task(read(ws, index)))
                    state = await call(
                        "POST",
                        "/api/comms/presence",
                        headers=headers[index],
                        json={"state": "online"},
                    )
                    if state.status_code != 200:
                        raise RuntimeError("Initial presence refused")
                    tasks.append(asyncio.create_task(presence(index)))
                except Exception as exc:
                    errors[type(exc).__name__] += 1
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    if isinstance(status, int):
                        handshakes[str(status)] += 1

        try:
            await asyncio.wait_for(asyncio.gather(*(admit(i) for i in range(count))), 180)
            value["join_ms"] = distribution(waits)
            value["footprint_joined"] = metrics.footprint()
            save()
            # Three protocol heartbeats idle; the S02 guard samples every five seconds.
            try:
                await asyncio.wait_for(shutdown.wait(), 60)
                raise RuntimeError("Required idle observation was interrupted")
            except TimeoutError:
                pass
            value["minimum_realtime_lifetime_before_burst_seconds"] = (
                min(expiries, default=0) - time.time()
            )
            assert value["minimum_realtime_lifetime_before_burst_seconds"] >= 60
            for index in (0, 4, 5):
                await login(index)
            latency, missing, extra = [], 0, 0
            sent = []
            for sample in range(30):
                marker = f"{count}-{sample}"
                response = await call(
                    "POST",
                    f"/api/comms/conversations/{room.conversation}/messages",
                    headers={**headers[(0, 4, 5)[sample % 3]], "X-Comms-Probe": marker},
                    json={"client_key": str(uuid4()), "body": f"Owned capacity {marker}"},
                )
                if response.status_code != 201:
                    raise RuntimeError("Actual message API refused")
                seq = response.json()["seq"]
                sent.append((marker, seq))

                async def delivered(seq=seq):
                    async with changed:
                        await changed.wait_for(
                            lambda: all((index, seq) in received for index in range(count))
                        )

                try:
                    await asyncio.wait_for(delivered(), 2)
                except TimeoutError:
                    pass
            traces = [
                json.loads(line)
                for line in Path(os.environ["OPENSLATE_COMMS_TELEMETRY"]).read_text().splitlines()
            ]
            commits = {row["sample"]: row["commit_ns"] for row in traces if "commit_ns" in row}
            for marker, seq in sent:
                assert marker in commits
                for index in range(count):
                    heard = received.get((index, seq), [])
                    if heard:
                        latency.append((heard[0] - commits[marker]) / 1e6)
                        extra += len(heard) - 1
                    else:
                        missing += 1
            value.update(
                expected_deliveries=30 * count,
                deliveries=len(latency),
                missing=missing,
                extra=extra,
                commit_to_delivery_ms=distribution(latency),
                footprint_after_burst=metrics.footprint(),
            )
            created = await call(
                "POST",
                "/api/comms/conversations",
                headers=headers[0],
                json={
                    "name": "Owned capacity discovery",
                    "scope": "organization",
                    "topic": "",
                    "category_id": None,
                    "position": 0,
                },
            )
            assert created.status_code == 201

            async def all_controls():
                async with changed:
                    await changed.wait_for(
                        lambda: all(len(rows) == count for rows in control_events.values())
                    )

            try:
                await asyncio.wait_for(all_controls(), 10)
            except TimeoutError:
                pass
            value["structure_recipients"] = len(control_events["structure"])
            value["grants_recipients"] = len(control_events["grants"])
            response = await api.get("/api/test/comms/metrics")
            assert response.status_code == 200
            value["publisher"] = response.json()
        finally:
            closing = True
            shutdown.set()
            pace.close()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.gather(*(ws.close() for ws in sockets), return_exceptions=True)
            try:
                response = await api.get("/api/test/comms/metrics", timeout=2)
                if response.status_code == 200:
                    value["publisher"] = response.json()
            except httpx.HTTPError:
                errors["metrics_unavailable"] += 1
            value.update(
                http_statuses=dict(statuses),
                route_statuses=dict(route_statuses),
                handshake_refusals=dict(handshakes),
                errors=dict(errors),
            )
            save()


@pytest.mark.parametrize("native_room", [300], indirect=True)
def test_d20_actual_three_hundred_socket_capacity(native_room):
    room, metrics = native_room, Metrics()
    identity = os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    path = REPOSITORY_ROOT / "backend/test-results/s20" / identity / "capacity.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    result = {
        "run_id": identity,
        "status": "running",
        "mechanism": (
            "real provider Auth, API token/grants, actual message API, "
            "private HTTP publish, same-origin WSS"
        ),
        "limits": metrics.limits(),
        "idle": metrics.footprint(),
        "cohorts": [],
        "machine": [machine()],
        "provider_fixture_jwt_seconds": 45,
        "realtime_jwt_seconds": 300,
    }

    def save():
        path.write_text(json.dumps(result, indent=2) + "\n")

    save()
    assert result["machine"][0]["ram_headroom_percent"] >= 20 and result["machine"][0]["load1"] <= 4

    async def run():
        for count in (300,):
            await cohort(room, count, metrics, result, save)

    asyncio.run(run())
    for row in result["cohorts"]:
        assert row["opened"] == row["fully_joined"] == row["attempted"]
        assert row["joined_topics"] == row["attempted"] * 20 and row["join_refusals"] == 0
        assert row["missing"] == row["extra"] == row["disconnections"] == 0
        assert not row["errors"] and not row["handshake_refusals"]
        assert set(row["http_statuses"]) <= {"200", "201", "204"}
        assert row["publisher"]["publisher"].get("rate_limited", 0) == 0
        assert row["publisher"]["publisher"].get("queue_full", 0) == 0
        assert row["publisher"]["pool_timeouts"] == 0
        assert row["structure_recipients"] == row["grants_recipients"] == row["attempted"]
        assert row["commit_to_delivery_ms"]["p95"] <= 1000
        assert (
            max(
                row["footprint_joined"]["realtime_memory_bytes"],
                row["footprint_after_burst"]["realtime_memory_bytes"],
            )
            <= 1024**3
        )
    result["status"] = "passed"
    save()
