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
from app.core.config.environment import environment_inputs
from app.core.config.instance import (
    assert_database_url,
    assert_instance_target,
    instance_target_for_process,
)
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from app.core.database import model_registry  # noqa: F401
from app.core.database.session import AuditSession, get_engine
from app.systems.access.identity.admin_recovery import (
    LocalRecoveryError,
    OrganizationChoiceRequired,
    recover_local_admin,
)


def is_elevated() -> bool:
    if os.name == "nt":
        return bool(cast(Any, ctypes).windll.shell32.IsUserAnAdmin())
    return os.geteuid() == 0


def add_organization_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--organization",
        metavar="ID_OR_SLUG",
        help="the organization the person administers; required when there are several",
    )


def organization_choice_message(refusal: str, error: OrganizationChoiceRequired) -> str:
    return (
        f"{refusal}: the account administers several organizations; rerun with "
        f"--organization <id or slug> (one of: {', '.join(error.slugs)})"
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("user_id", type=UUID)
    add_organization_argument(parser)
    args = parser.parse_args(argv)
    settings = get_settings()
    target = instance_target_for_process(settings.database_url, "openslate_runtime")
    if target is not None:
        assert_database_url(settings.database_url, target, expected_user="openslate_runtime")
        with get_engine().connect() as connection:
            assert_instance_target(connection, target, expected_user="openslate_runtime")
    try:
        assert_provider_instance(
            environment_inputs(DOTENV_PATH),
            database_url=settings.database_url,
            expected_user="openslate_runtime",
        )
        with AuditSession(get_engine()) as db:
            result = recover_local_admin(
                db,
                args.user_id,
                local_invocation=True,
                elevated=is_elevated(),
                organization=args.organization,
            )
    except Exception as error:
        if isinstance(error, OrganizationChoiceRequired):
            raise SystemExit(
                organization_choice_message("Administrator recovery was refused", error)
            ) from None
        if isinstance(error, LocalRecoveryError):
            raise SystemExit("Administrator recovery was refused") from None
        raise SystemExit("Administrator recovery failed") from None
    print(f"user_id={result.user_id} recovery_email_requested=true")
    print("Complete the emailed recovery link to choose a new password.")


if __name__ == "__main__":
    main()
