"""Operator-only, guarded upgrade/idempotency proof before the narrow API test process starts."""

import os

from psycopg import connect

from app.core.config.instance import assert_psycopg_target, instance_target_for_process
from operations import provision_database_role as provisioner


def main() -> None:
    env = dict(os.environ)
    bootstrap, owner, runtime = (
        env[key]
        for key in (
            "DATABASE_BOOTSTRAP_URL",
            "MIGRATION_DATABASE_URL",
            "DATABASE_URL",
        )
    )
    target = instance_target_for_process(owner, "openslate_owner", env)
    if (
        target is None
        or env.get("ENVIRONMENT") != "test"
        or env.get("E2E_ALLOW_MUTATIONS") != "true"
    ):
        raise RuntimeError("A guarded disposable target is required")
    connection_url = provisioner._psycopg_url(
        provisioner._postgres_url(bootstrap, name="bootstrap")
    )

    def alter(expression: str) -> None:
        with connect(connection_url) as connection:
            assert_psycopg_target(connection, target, expected_user="supabase_admin")
            connection.execute(
                "ALTER POLICY openslate_realtime_member_write ON realtime.messages "
                f"WITH CHECK ({expression})"
            )

    def provision() -> None:
        provisioner.provision(bootstrap, owner, runtime, instance_target=target)

    # This test fixture reproduces only the exact previously managed write policy.
    alter(provisioner.REALTIME_JOIN_EXPRESSION)
    provision()
    provision()  # Current pg_get_expr output must also be accepted without replacement.
    try:
        alter("true")
        try:
            provision()
        except RuntimeError as exc:
            if str(exc) != "Existing OpenSlate Realtime channel policy is unsafe":
                raise RuntimeError("Unexpected provisioning refusal") from None
        else:
            raise RuntimeError("An unknown policy was silently replaced")
        with connect(connection_url) as connection:
            assert_psycopg_target(connection, target, expected_user="supabase_admin")
            expression = connection.execute(
                "SELECT pg_get_expr(polwithcheck, polrelid) "
                "FROM pg_policy WHERE polrelid='realtime.messages'::regclass "
                "AND polname='openslate_realtime_member_write'"
            ).fetchone()
            if expression != ("true",):
                raise RuntimeError("An unknown policy was mutated before refusal")
    finally:
        alter(provisioner.REALTIME_WRITE_EXPRESSION)
    provision()
    print(
        "Managed Realtime policy: exact legacy upgrade, "
        "current idempotency and unknown refusal PASS"
    )


if __name__ == "__main__":
    main()
