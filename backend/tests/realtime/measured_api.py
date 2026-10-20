"""Run-owned API instrumentation only: real handlers/publisher, numeric timestamps and outcomes."""

import json
import os
import re
import threading
import time
from contextvars import ContextVar
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.pool import QueuePool

from app.core.database.session import AuditSession
from app.main import create_app
from app.systems.comms.realtime.publication import request_events

if (
    os.environ.get("ENVIRONMENT") != "test"
    or os.environ.get("OPENSLATE_COMMS_NATIVE_API") != "http://127.0.0.1:8008"
):
    raise RuntimeError("The guarded S20 native runner is required")

app = create_app()
sample: ContextVar[str | None] = ContextVar("s20_numeric_sample", default=None)
output = Path(os.environ["OPENSLATE_COMMS_TELEMETRY"])
lock = threading.Lock()
diagnostics = {"pool_timeouts": 0}
original_checkout = QueuePool._do_get


def checkout(pool):
    try:
        return original_checkout(pool)
    except PoolTimeout:
        with lock:
            diagnostics["pool_timeouts"] += 1
        raise


QueuePool._do_get = checkout


def record(row):
    with lock, output.open("a") as handle:
        output.chmod(0o600)
        handle.write(json.dumps(row) + "\n")


@event.listens_for(AuditSession, "after_commit")
def committed(db):
    marker = sample.get()
    if marker is None or db.in_nested_transaction():
        return
    created = [
        row["payload"]["seq"]
        for row in request_events.get() or []
        if row["event"] == "message" and row["payload"]["kind"] == "created"
    ]
    if created:
        record({"sample": marker, "commit_ns": time.perf_counter_ns(), "sequences": created})


class MeasureResponse:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        raw = dict(scope["headers"]).get(b"x-comms-probe", b"")
        marker = raw.decode("ascii") if re.fullmatch(rb"[0-9]{1,3}-[0-9]{1,3}", raw) else None
        token = sample.set(marker)

        async def observe(message):
            await send(message)
            if (
                marker
                and message["type"] == "http.response.body"
                and not message.get("more_body", False)
            ):
                record({"sample": marker, "response_ns": time.perf_counter_ns()})

        try:
            await self.app(scope, receive, observe)
        finally:
            sample.reset(token)


app.add_middleware(MeasureResponse)


@app.get("/api/test/comms/metrics", include_in_schema=False)
def metrics():
    publisher = app.state.comms_publisher
    return {
        "publisher": dict(publisher.outcomes),
        "queued": publisher.queue.unfinished_tasks,
        **diagnostics,
    }
