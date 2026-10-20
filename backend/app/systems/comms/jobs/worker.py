"""The existing scheduling thread invokes these bounded Comms polls in its bound org."""

from datetime import datetime

from sqlalchemy import Engine

from app.core.config import Settings
from app.core.database.organization_scope import current_worker_organization
from app.core.database.session import get_engine
from app.systems.comms.jobs.export_worker import execute_due_exports
from app.systems.comms.jobs.retention_worker import run_retention_batch
from app.systems.comms.jobs.schedule_worker import Publish, execute_due_schedules
from app.systems.platform.scheduling.worker import ReportSchedulingWorker


def scheduling_worker(settings: Settings, publish: Publish) -> ReportSchedulingWorker:
    return ReportSchedulingWorker(
        settings, comms_poll=lambda now: poll_comms(get_engine(), publish=publish, now=now),
    )


def poll_comms(engine: Engine, *, publish: Publish, now: datetime | None = None) -> None:
    org = current_worker_organization()
    if org is None:
        raise RuntimeError("Comms work requires a bound organization")
    failures = []
    # An unresolved external artifact must not postpone independent content erasure.
    for operation in (
        lambda: execute_due_schedules(engine, org, publish=publish, now=now),
        lambda: execute_due_exports(engine, org, now=now),
        lambda: run_retention_batch(engine, org, publish=publish, now=now),
    ):
        try:
            result = operation()
            if result is not None and result.get("failed"):
                raise RuntimeError("Retention cleanup remains unavailable")
        except Exception as exc:
            failures.append(exc)
    if failures:
        raise ExceptionGroup("Comms polling has unresolved work", failures)
