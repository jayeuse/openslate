"""Invoke the exact database-owned event deletion/proof capability."""

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
