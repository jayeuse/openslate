"""One serial worker attempt with fenced state changes around external work."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Never
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.files.access import authorize, fresh_user, load, parent
from app.systems.files.models import File
from app.systems.files.providers import (
    ProviderUnavailable,
    Scanner,
    ScannerExecutionUncertain,
    ScannerPolicyRejected,
    ScanVerdict,
    Storage,
    StorageCleanupUncertain,
)
from app.systems.files.scan_queue import LEASE_SECONDS, MAX_ATTEMPTS, RETRY_DELAYS, UNRESOLVED


class WorkerHalted(RuntimeError):
    """External work is unresolved; operator recovery is required before restart."""


@dataclass(frozen=True)
class ScanClaim:
    file_id: UUID
    operation_id: UUID
    requester_id: UUID
    key: str
    digest: str
    size: int


def utc_now() -> datetime:
    return datetime.now(UTC)


def system_audit(db: Session, operation_id: UUID | None = None) -> None:
    db.info[AUDIT_CONTEXT_KEY] = AuditContext(
        performed_by=None,
        request_id=operation_id or uuid4(),
        request_method="WORKER",
        request_path="/internal/files/scan",
    )


def require_resolved_engine(db: Session) -> None:
    unresolved = db.scalar(
        select(File.id)
        .where(
            File.state == "pending_scan",
            or_(File.operation_id.is_not(None), File.failure_code == UNRESOLVED),
        )
        .limit(1)
    )
    db.rollback()
    if unresolved is not None:
        raise WorkerHalted("Unresolved scan execution requires engine replacement acknowledgement")


def _suspend(file: File) -> None:
    file.failure_code = "scan_suspended"
    file.scan_next_attempt_at = None
    file.operation_id = None
    file.operation_expires_at = None


def claim_next(db: Session, now: datetime) -> ScanClaim | None:
    identity = db.scalar(
        select(File.id)
        .where(
            File.state == "pending_scan",
            File.operation_id.is_(None),
            File.scan_next_attempt_at <= now,
        )
        .order_by(File.scan_next_attempt_at, File.id)
        .limit(1)
    )
    if identity is None:
        db.rollback()
        return None
    file = load(db, identity, lock=True)
    # Reloaded after ancestor locks: another request may have changed the candidate.
    if (
        file.state != "pending_scan"
        or file.operation_id is not None
        or file.scan_next_attempt_at is None
        or file.scan_next_attempt_at > now
    ):
        db.rollback()
        return None
    token = uuid4()
    system_audit(db, token)
    if file.scan_requested_by is None:
        file.failure_code = "scan_adoption_required"
        file.scan_next_attempt_at = None
        db.commit()
        return None
    try:
        authorize(fresh_user(db, file.scan_requested_by), file.purpose, write=True)
        parent(db, file.record_id, active=True)
        if file.is_deleted:
            raise HTTPException(409, "File is archived")
    except HTTPException:
        _suspend(file)
        db.commit()
        return None
    if file.scan_attempts >= MAX_ATTEMPTS:
        file.failure_code = "scan_exhausted"
        file.scan_next_attempt_at = None
        db.commit()
        return None
    if file.digest is None or file.actual_size is None:
        file.state = "rejected"
        file.failure_code = "scan_integrity_error"
        file.scan_next_attempt_at = None
        db.commit()
        return None
    claim = ScanClaim(
        file.id, token, file.scan_requested_by, file.object_key, file.digest, file.actual_size
    )
    file.scan_attempts += 1
    file.operation_id = token
    file.operation_expires_at = now + timedelta(seconds=LEASE_SECONDS)
    file.scan_next_attempt_at = None
    file.failure_code = None
    db.commit()
    return claim


def _locked_claim(db: Session, claim: ScanClaim, now: datetime) -> File:
    file = load(db, claim.file_id, lock=True)
    if (
        file.state != "pending_scan"
        or file.operation_id != claim.operation_id
        or file.operation_expires_at is None
        or file.operation_expires_at <= now
        or file.digest != claim.digest
        or file.object_key != claim.key
        or file.actual_size != claim.size
        or file.scan_requested_by != claim.requester_id
    ):
        db.rollback()
        raise WorkerHalted("Scan claim changed or expired before completion")
    system_audit(db, claim.operation_id)
    return file


def mark_uncertain(db: Session, claim: ScanClaim) -> Never:
    db.rollback()
    file = load(db, claim.file_id, lock=True)
    if file.state == "pending_scan" and file.operation_id == claim.operation_id:
        system_audit(db, claim.operation_id)
        file.failure_code = UNRESOLVED
        file.scan_next_attempt_at = None
        db.commit()
    else:
        db.rollback()
    raise WorkerHalted("Submitted scanner execution is unresolved")


def finish_attempt(
    db: Session,
    claim: ScanClaim,
    now: datetime,
    *,
    verdict: ScanVerdict | None = None,
    failure: str | None = None,
) -> None:
    file = _locked_claim(db, claim, now)
    try:
        authorize(fresh_user(db, claim.requester_id), file.purpose, write=True)
        parent(db, file.record_id, active=True)
        if file.is_deleted:
            raise HTTPException(409, "File is archived")
    except HTTPException:
        _suspend(file)
        db.commit()
        return
    file.operation_id = None
    file.operation_expires_at = None
    if verdict is not None:
        file.state = "ready" if verdict.outcome == "clean" else "rejected"
        file.failure_code = None if verdict.outcome == "clean" else "scan_infected"
        file.scanner_version = verdict.scanner_version
        file.signature_version = verdict.signature_version
    elif failure in {"scan_integrity_error", "scan_policy_rejected"}:
        file.state = "rejected"
        file.failure_code = failure
    elif file.scan_attempts >= MAX_ATTEMPTS:
        file.failure_code = "scan_exhausted"
    else:
        file.failure_code = "scan_unavailable"
        file.scan_next_attempt_at = now + timedelta(seconds=RETRY_DELAYS[file.scan_attempts - 1])
    db.commit()


def process_next(
    db: Session,
    storage: Storage,
    scanner: Scanner,
    *,
    clock: Callable[[], datetime] = utc_now,
    verify_leader: Callable[[], None] | None = None,
) -> bool:
    """Readiness failures consume no attempt. Caller owns the deployment leader lock."""
    require_resolved_engine(db)
    try:
        scanner.probe()
    except ScannerExecutionUncertain as exc:
        # An unreaped probe client may still exist; never accumulate more clients.
        raise WorkerHalted("Scanner probe cleanup is unresolved") from exc
    except ProviderUnavailable:
        return False
    if verify_leader:
        verify_leader()
    try:
        claim = claim_next(db, clock())
    except OperationalError as exc:
        db.rollback()
        if getattr(exc.orig, "sqlstate", None) == "55P03":
            return False
        raise
    if claim is None:
        return False
    try:
        content = storage.download(claim.key)
    except StorageCleanupUncertain as exc:
        try:
            finish_attempt(db, claim, clock(), failure="scan_unavailable")
        except Exception:
            # The runtime must halt even when persisting the retry fails.
            raise WorkerHalted("Storage cleanup requires runtime replacement") from exc
        raise WorkerHalted("Storage cleanup requires runtime replacement") from exc
    except ProviderUnavailable:
        finish_attempt(db, claim, clock(), failure="scan_unavailable")
        return True
    if content is None or len(content) != claim.size or sha256(content).hexdigest() != claim.digest:
        finish_attempt(db, claim, clock(), failure="scan_integrity_error")
        return True
    try:
        if verify_leader:
            verify_leader()
        verdict = scanner.scan(content, digest=claim.digest, operation_id=claim.operation_id)
    except ScannerExecutionUncertain:
        mark_uncertain(db, claim)
    except ScannerPolicyRejected:
        finish_attempt(db, claim, clock(), failure="scan_policy_rejected")
        return True
    except ProviderUnavailable:
        finish_attempt(db, claim, clock(), failure="scan_unavailable")
        return True
    except Exception:
        # Unexpected transport/provider failure after admission cannot establish engine completion.
        mark_uncertain(db, claim)
    if (
        verdict.digest != claim.digest
        or verdict.outcome not in {"clean", "infected"}
        or not verdict.scanner_version
        or not verdict.signature_version
        or len(verdict.scanner_version) > 200
        or len(verdict.signature_version) > 200
    ):
        mark_uncertain(db, claim)
    if verify_leader:
        verify_leader()
    finish_attempt(db, claim, clock(), verdict=verdict)
    return True
