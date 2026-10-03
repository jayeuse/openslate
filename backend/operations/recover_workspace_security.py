"""Recover workspace MFA and IP restrictions from an elevated local console."""

import argparse
import sys
from pathlib import Path
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
from app.systems.access.identity.security_recovery import (
    LocalSecurityRecoveryError,
    recover_workspace_security,
)
from operations.recover_local_admin import is_elevated


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("user_id", type=UUID)
    args = parser.parse_args(argv)
    try:
        if not is_elevated():
            raise LocalSecurityRecoveryError("An elevated local console is required")
        settings = get_settings()
        target = instance_target_for_process(settings.database_url, "openslate_runtime")
        if target is None:
            raise LocalSecurityRecoveryError("Instance attestation is required")
        assert_database_url(settings.database_url, target, expected_user="openslate_runtime")
        with get_engine().connect() as connection:
            assert_instance_target(connection, target, expected_user="openslate_runtime")
        assert_provider_instance(
            environment_inputs(DOTENV_PATH),
            database_url=settings.database_url,
            expected_user="openslate_runtime",
        )
        with AuditSession(get_engine()) as db:
            result = recover_workspace_security(
                db, args.user_id, local_invocation=True, elevated=True
            )
    except LocalSecurityRecoveryError as error:
        if error.local_reset_committed is False:
            raise SystemExit("Workspace security recovery was refused") from None
        states = {True: "true", False: "false", None: "unknown"}
        raise SystemExit(
            "Workspace security recovery incomplete; "
            f"local_reset_committed={states[error.local_reset_committed]} "
            f"provider_factors_cleared={states[error.provider_factors_cleared]}. "
            "Rerun this command after resolving the failure."
        ) from None
    except Exception:
        raise SystemExit("Workspace security recovery failed") from None
    print(
        f"user_id={result.user_id} mfa_policy=optional ip_allow_list_cleared=true "
        "provider_factors_cleared=true sessions_revoked=true"
    )
    print("Sign in again to configure MFA and the workspace security policy.")


if __name__ == "__main__":
    main()
