"""Invoke the exact database-owned routines: event deletion and audit partition creation."""

from typing import cast

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session


def retain_security_events(db: Session) -> int:
    """Own one transaction; the routine inserts its fixed proof before returning."""
    try:
        count = cast(int, db.scalar(select(func.public.retain_security_events())))
        if count:
            db.commit()
        else:
            db.rollback()
        return count
    except SQLAlchemyError:
        db.rollback()
        raise


def ensure_audit_partitions(db: Session) -> int:
    """Own one transaction; return the months skipped because `DEFAULT` holds their rows."""
    try:
        skipped = cast(int, db.scalar(select(func.public.ensure_audit_partitions())))
        db.commit()
        return skipped
    except SQLAlchemyError:
        db.rollback()
        raise
