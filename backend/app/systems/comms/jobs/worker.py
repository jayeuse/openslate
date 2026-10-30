"""The existing scheduling thread invokes these bounded Comms polls in its bound org."""

from datetime import datetime

from sqlalchemy import Engine

from app.core.config import Settings
from app.core.database.organization_scope import current_worker_organization
from app.core.database.session import get_engine
from app.core.observability import failure_cause
from app.systems.comms.jobs.export_worker import execute_due_exports
from app.systems.comms.jobs.retention_worker import run_retention_batch
from app.systems.comms.jobs.schedule_worker import Publish, execute_due_schedules
from app.systems.comms.previews.jobs import execute_due_previews
from app.systems.platform.scheduling.worker import ReportSchedulingWorker


def scheduling_worker(settings: Settings, publish: Publish) -> ReportSchedulingWorker:
    return ReportSchedulingWorker(
        settings, comms_poll=lambda now: poll_comms(get_engine(), publish=publish, now=now),
    )


def poll_comms(engine: Engine, *, publish: Publish, now: datetime | None = None) -> None:
    org = current_worker_organization()
    if org is None:
        raise RuntimeError("Comms work requires a bound organization")
    failures: list[Exception] = []
    causes: list[str] = []
    # An unresolved external artifact must not postpone independent content erasure.
    for name, operation in (
        ("schedules", lambda: execute_due_schedules(engine, org, publish=publish, now=now)),
        ("exports", lambda: execute_due_exports(engine, org, now=now)),
        ("retention", lambda: run_retention_batch(engine, org, publish=publish, now=now)),
        ("previews", lambda: execute_due_previews(engine, org, publish=publish, now=now)),
    ):
        try:
            result = operation()
            if result is not None and result.get("failed"):
                causes.append(f"{name}:retention_storage_unavailable")
                failures.append(RuntimeError("Retention cleanup remains unavailable"))
        except Exception as exc:
            causes.append(f"{name}:{failure_cause(exc)}")
            failures.append(exc)
    if failures:
        group = ExceptionGroup("Comms polling has unresolved work", failures)
        # failure_cause() logs this bounded summary, never the members' messages.
        group.cause_code = ",".join(causes)  # type: ignore[attr-defined]
        raise group
