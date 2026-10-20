"""Reuse provider step-up and exact administrator serialization; never persist a password."""

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.common.dependencies import require_fresh_exact_admin
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.sandbox.lifecycle.exceptions import LifecycleError
from app.systems.sandbox.lifecycle.password import ProviderPasswordGrantClient


def admin(db: Session, actor: User) -> User:
    try:
        return require_fresh_exact_admin(db, actor.id, serialize_admin_changes=True)
    except HTTPException as exc:
        db.rollback()
        if exc.status_code == 403:
            raise error(
                "comms_admin_required", "Current organization administrator required", 403
            ) from exc
        raise


def password_admin(db: Session, actor: User, password: str | None) -> User:
    current = admin(db, actor)
    identity, email = current.id, current.email
    db.rollback()  # No source or administrator lock is held over provider I/O.
    if not password:
        raise error("comms_fresh_admin_required", "Fresh password confirmation is required", 403)
    try:
        verified = ProviderPasswordGrantClient(db).verify_password(email, password)
    except LifecycleError as exc:
        db.rollback()
        raise error(
            "comms_fresh_admin_required" if exc.status_code == 403 else "comms_unavailable",
            "Fresh password confirmation failed",
            int(exc.status_code),
        ) from exc
    if verified != identity:
        db.rollback()
        raise error("comms_fresh_admin_required", "Password identity differs", 403)
    reloaded = db.get(User, identity, populate_existing=True)
    if reloaded is None:
        raise error("comms_admin_required", "Administrator unavailable", 403)
    return admin(db, reloaded)
