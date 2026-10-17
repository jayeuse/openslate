"""Fresh-administrator job metadata and atomic manual retry commands."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from sqlalchemy import case, func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user, require_fresh_exact_admin
from app.common.listing import ListQuerySpec, StandardListResponse, execute_standard_list
from app.core.database import get_db
from app.systems.access.users.membership import is_platform_operator
from app.systems.access.users.models import User
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.backups import service as backups
from app.systems.manage.jobs import registry
from app.systems.manage.jobs.schemas import JobResponse, JobsListRequest, JobSort

router = APIRouter(prefix="/jobs", tags=["jobs"])
Actor = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _error(code: str, status: int = 409) -> HTTPException:
    messages = {
        "job_not_found": "Job not found",
        "job_not_retryable": "This job cannot be retried",
        "job_retry_key_required": "Backup retry requires an Idempotency-Key",
        "jobs_unavailable": "Job metadata is unavailable",
        "job_filter_invalid": "Unknown job kind or state",
    }
    return HTTPException(
        status,
        detail={"code": code, "message": messages[code]},
        headers={"Cache-Control": "no-store"},
    )


@router.get("", response_model=StandardListResponse[JobResponse], operation_id="list_jobs")
def list_jobs(
    params: Annotated[JobsListRequest, Query()], actor: Actor, db: Database, response: Response
) -> StandardListResponse[JobResponse]:
    require_fresh_exact_admin(db, actor.id)
    states = set().union(*(entry.states for entry in registry.REGISTRY.values()))
    if (params.kind is not None and params.kind not in registry.REGISTRY) or (
        params.state is not None and params.state not in states
    ):
        raise _error("job_filter_invalid", 422)
    try:
        statement, columns = registry.jobs_query(backups.installation_id(db))
        if not is_platform_operator(db, actor.id):
            statement = statement.where(columns.kind != "backup")
        for name in ("kind", "state"):
            value = getattr(params, name)
            if value is not None:
                statement = statement.where(columns[name] == value)
        if params.scheduled_after is not None:
            statement = statement.where(columns.effective_at >= params.scheduled_after)
        if params.scheduled_before is not None:
            statement = statement.where(columns.effective_at < params.scheduled_before)
        priority = func.row(
            case((columns.state == "failed", 0), else_=1),
            -func.extract("epoch", columns.effective_at),
        )
        spec = ListQuerySpec(
            sort_fields={
                JobSort.PRIORITY: priority,
                **{
                    field: columns[field.value]
                    for field in JobSort
                    if field is not JobSort.PRIORITY
                },
            },
            default_sort=JobSort.PRIORITY,
            tie_breaker=func.row(columns.id, columns.kind),
            search_fields=(columns.subject_label, columns.kind_label),
        )
        listed = execute_standard_list(db, statement, params, spec)
        result: StandardListResponse[JobResponse] = StandardListResponse(
            items=[registry.response(row) for row in listed.items], pagination=listed.pagination
        )
    except (SQLAlchemyError, backups.BackupStateError) as error:
        db.rollback()
        raise _error("jobs_unavailable", 503) from error
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post(
    "/{kind}/{job_id}/retry",
    response_model=JobResponse,
    operation_id="retry_job",
    responses={
        201: {"model": JobResponse, "headers": {"Location": {"schema": {"type": "string"}}}}
    },
)
def retry_job(
    kind: str,
    job_id: UUID,
    actor: Actor,
    db: Database,
    response: Response,
    idempotency_key: Annotated[
        str | None,
        Header(
            min_length=1,
            max_length=128,
            pattern=r"^[A-Za-z0-9._:-]+$",
            description="Required for backup retry; scheduled retries use a state guard",
        ),
    ] = None,
) -> JobResponse:
    require_fresh_exact_admin(db, actor.id)
    entry = registry.REGISTRY.get(kind)
    if entry is None:
        raise _error("job_filter_invalid", 422)
    if entry.retry is None:
        raise _error("job_not_retryable")
    try:
        result_id, replay = entry.retry(db, kind, job_id, actor.id, idempotency_key)
        if not replay:
            append_security_event(
                db,
                SecurityEventIngestRequest(
                    event_type="job.retry",
                    outcome=SecurityEventOutcome.SUCCESS,
                    source="jobs",
                    operation_id=result_id if kind == "backup" else uuid7(),
                    actor_id=actor.id,
                    subject_id=job_id,
                    metadata={"kind": kind, "result_id": str(result_id)},
                ),
            )
        statement, columns = registry.jobs_query(backups.installation_id(db))
        row = db.scalar(statement.where(columns.kind == kind, columns.id == result_id))
        if row is None:
            raise registry.JobStateError("job_not_found")
        result = registry.response(row)
        db.commit()
    except registry.JobStateError as error:
        db.rollback()
        code = str(error)
        raise _error(
            code,
            404 if code == "job_not_found" else 422 if code == "job_retry_key_required" else 409,
        ) from error
    except (SQLAlchemyError, backups.BackupStateError) as error:
        db.rollback()
        raise _error("jobs_unavailable", 503) from error
    response.headers["Cache-Control"] = "no-store"
    if kind == "backup":
        response.status_code = 201
        response.headers["Location"] = f"/api/backups?run_id={result.id}"
    return result
