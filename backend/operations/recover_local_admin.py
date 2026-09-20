"""Recover an active administrator from an elevated local console."""

import argparse
import ctypes
import os
import sys
from pathlib import Path
from typing import Any, cast
from uuid import UUID

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.admin_recovery import LocalRecoveryError, recover_local_admin


def is_elevated() -> bool:
    if os.name == "nt":
        return bool(cast(Any, ctypes).windll.shell32.IsUserAnAdmin())
    return os.geteuid() == 0


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("user_id", type=UUID)
    args = parser.parse_args(argv)
    get_settings()
    try:
        with AuditSession(get_engine()) as db:
            result = recover_local_admin(
                db, args.user_id, local_invocation=True, elevated=is_elevated()
            )
    except Exception as error:
        if isinstance(error, LocalRecoveryError):
            raise SystemExit("Administrator recovery was refused") from None
        raise SystemExit("Administrator recovery failed") from None
    print(f"user_id={result.user_id} temporary_password={result.temporary_password}")


if __name__ == "__main__":
    main()
