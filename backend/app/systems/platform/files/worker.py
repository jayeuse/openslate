"""Serial deployment scanner: python -m app.systems.platform.files.worker."""

import argparse
import sys
from datetime import datetime
from time import sleep
from types import TracebackType

from sqlalchemy import Connection, Engine, or_, select, text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import ConfigurationError
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import AuditSession, get_engine
from app.systems.platform.files.access import load
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import get_scanner, transfer_slot
from app.systems.platform.files.quota import RESERVATION_TTL
from app.systems.platform.files.scan_processing import (
    WorkerHalted,
    process_next,
    require_resolved_engine,
    system_audit,
    utc_now,
)
from app.systems.platform.files.scan_queue import MAX_ATTEMPTS, UNRESOLVED
from app.systems.platform.files.storage import get_storage

LEADER_LOCK = 57168423129478012


class ScannerLeader:
    """Dedicated autocommit session owns leadership, separate from application transactions."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.connection: Connection | None = None
        self.pid: int | None = None

    def __enter__(self) -> "ScannerLeader":
        connection = self.engine.connect().execution_options(isolation_level="AUTOCOMMIT")
        self.connection = connection
        try:
            acquired = connection.scalar(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": LEADER_LOCK}
            )
            if not acquired:
                raise WorkerHalted("Another scanner worker owns deployment leadership")
            self.pid = connection.scalar(text("SELECT pg_backend_pid()"))
        except BaseException:
            connection.close()
            self.connection = None
            raise
        return self

    def verify(self) -> None:
        connection = self.connection
        if connection is None or connection.closed or connection.invalidated:
            raise WorkerHalted("Scanner leadership connection was lost")
        if connection.scalar(text("SELECT pg_backend_pid()")) != self.pid:
            raise WorkerHalted("Scanner leadership session changed")

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        connection = self.connection
        if connection is not None:
            try:
                if not connection.closed and not connection.invalidated:
                    connection.execute(
                        text("SELECT pg_advisory_unlock(:key)"), {"key": LEADER_LOCK}
                    )
            finally:
                connection.close()
                self.connection = None


def acknowledge_engine_replacement(db: Session) -> int:
    """Operator-only CLI recovery. Caller MUST hold ScannerLeader for the whole operation."""
    identities = list(
        db.scalars(
            select(File.id)
            .where(
                File.state == "pending_scan",
                or_(File.operation_id.is_not(None), File.failure_code == UNRESOLVED),
            )
            .order_by(File.id)
        )
    )
    for identity in identities:
        file = load(db, identity, lock=True)
        system_audit(db)
        file.operation_id = None
        file.operation_expires_at = None
        if file.scan_attempts >= MAX_ATTEMPTS:
            file.failure_code = "scan_exhausted"
            file.scan_next_attempt_at = None
        elif file.scan_requested_by is None:
            file.failure_code = "scan_adoption_required"
            file.scan_next_attempt_at = None
        else:
            file.failure_code = None
            file.scan_next_attempt_at = utc_now()
        db.commit()
    db.rollback()
    return len(identities)


def expire_unused_reservations(db: Session, now: datetime) -> int:
    identities = list(
        db.scalars(
            select(File.id)
            .where(
                File.state == "awaiting_upload",
                File.created_at <= now - RESERVATION_TTL,
                File.operation_id.is_(None),
                File.digest.is_(None),
                File.actual_size.is_(None),
                File.scan_requested_by.is_(None),
            )
            .order_by(File.created_at, File.id)
            .limit(100)
        )
    )
    expired = 0
    for identity in identities:
        try:
            file = load(db, identity, lock=True)
        except OperationalError as exc:
            db.rollback()
            if getattr(exc.orig, "sqlstate", None) == "55P03":
                continue
            raise
        if (
            file.state != "awaiting_upload"
            or file.operation_id is not None
            or file.digest is not None
            or file.actual_size is not None
            or file.scan_requested_by is not None
            or file.created_at > now - RESERVATION_TTL
        ):
            continue
        system_audit(db)
        file.state = "purged"
        file.is_deleted = True
        file.deleted_at = now
        file.failure_code = "file_reservation_expired"
        db.commit()
        expired += 1
    db.rollback()
    return expired


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the deployment's serial file scanner")
    parser.add_argument(
        "--acknowledge-engine-replacement",
        action="store_true",
        help="Confirm the old engine was replaced before fencing unresolved scans",
    )
    options = parser.parse_args()
    try:
        scanner = get_scanner(require_configuration=True)
        engine = get_engine()
        with ScannerLeader(engine) as leader:
            with AuditSession(engine) as db:
                if options.acknowledge_engine_replacement:
                    acknowledge_engine_replacement(db)
                require_resolved_engine(db)
            storage = get_storage()
            while True:
                leader.verify()
                with AuditSession(engine) as db:
                    expire_unused_reservations(db, utc_now())
                    with transfer_slot():
                        processed = process_next(db, storage, scanner, verify_leader=leader.verify)
                if not processed:
                    sleep(30)
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return 2
    except (WorkerHalted, SQLAlchemyError):
        print("File scanner stopped; inspect unresolved work before restarting", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
