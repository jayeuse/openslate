"""Clear application data while preserving the configured administrator account."""

import os

from sqlalchemy import text

from app.core.config import get_settings
from app.core.database.session import get_engine


def main() -> None:
    username = os.environ.get("ADMIN_BOOTSTRAP_USERNAME") or get_settings().admin_bootstrap_username
    if not username:
        raise SystemExit("ADMIN_BOOTSTRAP_USERNAME must identify the account to preserve")

    engine = get_engine()
    with engine.begin() as connection:
        admin = connection.execute(
            text("SELECT id, role_id FROM users WHERE username = :username"),
            {"username": username.lower()},
        ).one_or_none()
        if admin is None:
            raise SystemExit(f"Configured administrator {username!r} was not found")

        parameters = {"admin_id": admin.id, "admin_role_id": admin.role_id}
        connection.execute(text("DELETE FROM audit_logs"))
        connection.execute(text("DELETE FROM records"))
        connection.execute(text("DELETE FROM fields"))
        connection.execute(text("DELETE FROM modules"))
        connection.execute(text("DELETE FROM departments"))
        connection.execute(text("DELETE FROM users WHERE id <> :admin_id"), parameters)
        connection.execute(text("DELETE FROM roles WHERE id <> :admin_role_id"), parameters)
        connection.execute(
            text(
                "UPDATE users SET is_deleted = false, deleted_at = NULL, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = :admin_id"
            ),
            parameters,
        )
        connection.execute(
            text(
                "UPDATE roles SET is_deleted = false, deleted_at = NULL, "
                "updated_at = CURRENT_TIMESTAMP WHERE id = :admin_role_id"
            ),
            parameters,
        )
    print(f"Cleared application data; preserved administrator {username.lower()}")


if __name__ == "__main__":
    main()
