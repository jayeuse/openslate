"""The support files: one for the installation owner, one per organization (S6-C2, S6-C3).

Neither file holds a record, a person or a request value. The organization file holds only
installation-wide parts and the bound organization's own storage and server errors (R4).
The installation file reads each organization in its own bound session, then the server
errors of no organization in an unbound one, because row security admits nothing else.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import ColumnElement, column, func, select, table
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column, worker_organization
from app.core.database.session import AuditSession, get_engine
from app.systems.access.users.models import User
from app.systems.manage.health import history, installation, service
from app.systems.manage.health.models import ServerError
from app.systems.manage.health.schemas import (
    HealthPeriod,
    InstallationWorker,
    SystemPart,
    WorkerKey,
)
from app.systems.manage.workspace.models import WorkspaceProfile

MAX_PERIODS = 1000
MAX_ERRORS = 1000
SAMPLE_COLUMNS = (
    "sampled_at", "data_status", "data_ms", "signing_in_status", "signing_in_ms",
    "files_status", "files_ms", "email_status",
)


class InstallationVersions(BaseModel):
    application: str
    schema_revision: str | None
    postgresql: str | None


class OrganizationVersions(BaseModel):
    application: str


class DatabaseSize(BaseModel):
    bytes: int | None
    measured_at: datetime | None


class OrganizationStorageTotal(BaseModel):
    org_id: UUID
    storage_used_bytes: int | None


class StorageInUse(BaseModel):
    used_bytes: int | None


class SampleTable(BaseModel):
    columns: list[str]
    rows: list[list[datetime | str | int | None]]


class OrganizationServerError(BaseModel):
    request_id: UUID
    occurred_at: datetime
    status: int
    method: str
    route: str


class InstallationServerError(OrganizationServerError):
    org_id: UUID | None


class InstallationServerErrors(BaseModel):
    total_30d: int
    truncated: bool
    items: list[InstallationServerError]


class OrganizationServerErrors(BaseModel):
    total_30d: int
    truncated: bool
    items: list[OrganizationServerError]


class InstallationSummary(BaseModel):
    kind: Literal["installation"]
    generated_at: datetime
    application_version: str
    parts: list[SystemPart]
    problem_periods_30d: int
    server_errors_30d: int
    workers_not_running: list[WorkerKey]
    database_bytes: int | None


class OrganizationSummary(BaseModel):
    kind: Literal["organization"]
    generated_at: datetime
    application_version: str
    parts: list[SystemPart]
    problem_periods_30d: int
    server_errors_30d: int
    storage_used_bytes: int | None


class InstallationDiagnostics(BaseModel):
    summary: InstallationSummary
    versions: InstallationVersions
    database: DatabaseSize
    workers: list[InstallationWorker]
    organizations: list[OrganizationStorageTotal]
    samples: SampleTable
    periods: list[HealthPeriod]
    server_errors: InstallationServerErrors


class OrganizationDiagnostics(BaseModel):
    summary: OrganizationSummary
    versions: OrganizationVersions
    periods: list[HealthPeriod]
    storage: StorageInUse
    server_errors: OrganizationServerErrors


def file_name(kind: Literal["installation", "organization"], now: datetime) -> str:
    return f"slateops-diagnostics-{kind}-{now:%Y%m%d-%H%M}Z.json"


def _errors(
    db: Session, scope: ColumnElement[bool], since: datetime
) -> tuple[int, list[ServerError]]:
    where = (scope, ServerError.occurred_at >= since)
    total = int(db.scalar(select(func.count()).select_from(ServerError).where(*where)) or 0)
    rows = list(
        db.scalars(
            select(ServerError)
            .where(*where)
            .order_by(ServerError.occurred_at.desc(), ServerError.request_id.desc())
            .limit(MAX_ERRORS)
        )
    )
    return total, rows


def _periods(current: history.HealthHistory) -> list[HealthPeriod]:
    return [
        HealthPeriod(
            part=period.part, kind=period.kind,
            started_at=period.started_at, ended_at=period.ended_at,
        )
        for period in current.periods[:MAX_PERIODS]
    ]


def _parts(db: Session, current: history.HealthHistory, now: datetime) -> list[SystemPart]:
    # No pooled connection may idle in a transaction while the readiness probe runs.
    db.rollback()
    snapshot, _checked_at = service.cached_readiness()
    return service.system_parts(snapshot, current, now=now)


def organization_file(db: Session, version: str, now: datetime) -> OrganizationDiagnostics:
    """The bound organization's file; the caller has checked that the person is its admin."""

    current = history.read_history(db, now)
    parts = _parts(db, current, now)
    used = installation.storage_used_bytes(db)
    total, rows = _errors(
        db, ServerError.org_id == bound_organization_column(), now - history.WINDOW
    )
    db.rollback()
    return OrganizationDiagnostics(
        summary=OrganizationSummary(
            kind="organization", generated_at=now, application_version=version, parts=parts,
            problem_periods_30d=len(current.periods), server_errors_30d=total,
            storage_used_bytes=used,
        ),
        versions=OrganizationVersions(application=version),
        periods=_periods(current),
        storage=StorageInUse(used_bytes=used),
        server_errors=OrganizationServerErrors(
            total_30d=total,
            truncated=total > len(rows),
            items=[
                OrganizationServerError(
                    request_id=row.request_id, occurred_at=row.occurred_at,
                    status=row.status, method=row.method, route=row.route,
                )
                for row in rows
            ],
        ),
    )


def _organization_ids() -> list[UUID]:
    """Every organization, with no deleted filter: the file covers each one's errors."""

    with Session(get_engine()) as db:
        return list(db.scalars(select(WorkspaceProfile.id).order_by(WorkspaceProfile.id)))


def _every_organization(
    since: datetime,
) -> tuple[list[OrganizationStorageTotal], int, list[ServerError]]:
    totals: list[OrganizationStorageTotal] = []
    count = 0
    rows: list[ServerError] = []
    for org_id in _organization_ids():
        with worker_organization(org_id), AuditSession(bind=get_engine()) as db:
            totals.append(OrganizationStorageTotal(
                org_id=org_id, storage_used_bytes=installation.storage_used_bytes(db, org_id),
            ))
            found, kept = _errors(db, ServerError.org_id == org_id, since)
            count += found
            rows += kept
            db.expunge_all()
            db.rollback()
    with AuditSession(bind=get_engine()) as db:
        found, kept = _errors(db, ServerError.org_id.is_(None), since)
        count += found
        rows += kept
        db.expunge_all()
        db.rollback()
    rows.sort(key=lambda row: (row.occurred_at, row.request_id), reverse=True)
    return totals, count, rows[:MAX_ERRORS]


def installation_file(
    db: Session, person: User, version: str, now: datetime
) -> InstallationDiagnostics:
    """The installation owner's file; the caller has checked that the person owns it."""

    samples = history.read_samples(db, now - history.WINDOW)
    current = history.history_from(db, samples, now)
    parts = _parts(db, current, now)
    status = installation.installation_status(db, person, now=now)
    if status is None:
        raise PermissionError("installation owner required")
    # Core selects: the audited session refuses raw statements it cannot classify.
    schema_revision = db.scalar(
        select(column("version_num")).select_from(table("alembic_version", schema="public"))
    )
    postgresql = db.scalar(select(func.current_setting("server_version")))
    db.rollback()
    totals, total, rows = _every_organization(now - history.WINDOW)
    return InstallationDiagnostics(
        summary=InstallationSummary(
            kind="installation", generated_at=now, application_version=version, parts=parts,
            problem_periods_30d=len(current.periods), server_errors_30d=total,
            workers_not_running=[
                worker.key for worker in status.workers if worker.state != "running"
            ],
            database_bytes=status.database_bytes,
        ),
        versions=InstallationVersions(
            application=version, schema_revision=schema_revision, postgresql=postgresql
        ),
        database=DatabaseSize(
            bytes=status.database_bytes, measured_at=status.database_measured_at
        ),
        workers=status.workers,
        organizations=totals,
        samples=SampleTable(
            columns=list(SAMPLE_COLUMNS),
            rows=[
                [
                    sample.sampled_at,
                    sample.statuses["data"], sample.times["data"],
                    sample.statuses["signing_in"], sample.times["signing_in"],
                    sample.statuses["files"], sample.times["files"],
                    sample.statuses["email"],
                ]
                for sample in samples
            ],
        ),
        periods=_periods(current),
        server_errors=InstallationServerErrors(
            total_30d=total,
            truncated=total > len(rows),
            items=[
                InstallationServerError(
                    request_id=row.request_id, occurred_at=row.occurred_at,
                    status=row.status, method=row.method, route=row.route, org_id=row.org_id,
                )
                for row in rows
            ],
        ),
    )
