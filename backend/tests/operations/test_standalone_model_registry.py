"""Standalone entry points load the complete ORM model registry in a fresh interpreter."""

import subprocess
import sys

import pytest


@pytest.mark.parametrize(
    "imports",
    [
        pytest.param("import operations.bootstrap_admin; ", id="bootstrap_admin"),
        pytest.param("import operations.recover_local_admin; ", id="recover_local_admin"),
        pytest.param(
            "import tests.fullstack_runner; "
            "from app.core.integrations.supabase_auth import SupabaseAuthClient; "
            "from app.systems.access.users.models import User, UserStatus; ",
            id="fullstack_runner",
        ),
    ],
)
def test_standalone_entry_point_loads_the_complete_model_registry(imports: str) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            f"from sqlalchemy.orm import configure_mappers; {imports}configure_mappers()",
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
