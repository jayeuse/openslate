"""Create the first administrator without exposing an unauthenticated API."""

import argparse
import getpass
import os
import re

from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.database.session import AuditSession, get_engine
from app.core.security import hash_password
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.users.models import Role, User, UserRole

USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username")
    parser.add_argument(
        "--from-env",
        action="store_true",
        help="read ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD",
    )
    args = parser.parse_args()
    settings = get_settings()
    username_value = (
        (os.environ.get("ADMIN_BOOTSTRAP_USERNAME") or settings.admin_bootstrap_username)
        if args.from_env
        else args.username
    )
    if not username_value:
        parser.error("--username is required unless --from-env is used")
    username = username_value.lower()
    if not 3 <= len(username) <= 100 or USERNAME_PATTERN.fullmatch(username) is None:
        parser.error("username must be 3-100 characters using letters, numbers, '_' or '-'")

    if args.from_env:
        password = os.environ.get("ADMIN_BOOTSTRAP_PASSWORD") or (
            settings.admin_bootstrap_password.get_secret_value()
            if settings.admin_bootstrap_password is not None
            else ""
        )
        confirmation = password
    else:
        password = getpass.getpass("Admin password: ")
        confirmation = getpass.getpass("Confirm admin password: ")
    if len(password) < 12 or len(password) > 128:
        parser.error("password must be 12-128 characters")
    if password != confirmation:
        parser.error("passwords do not match")

    with AuditSession(get_engine()) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext()
        active_admins = db.scalar(
            select(func.count())
            .select_from(User)
            .join(Role, User.role_id == Role.id)
            .where(
                User.is_deleted.is_(False),
                Role.is_deleted.is_(False),
                Role.role == UserRole.ADMIN,
            )
        )
        if active_admins:
            print("An active administrator already exists; bootstrap skipped")
            return

        role = db.scalar(
            select(Role).where(Role.role == UserRole.ADMIN, Role.is_deleted.is_(False))
        )
        if role is None:
            raise SystemExit("The active admin role is not configured")
        if db.scalar(select(User.id).where(User.username == username)) is not None:
            raise SystemExit("Username unavailable")

        db.add(User(username=username, password_hash=hash_password(password), role_id=role.id))
        db.commit()
    print(f"Created administrator {username}")


if __name__ == "__main__":
    main()
