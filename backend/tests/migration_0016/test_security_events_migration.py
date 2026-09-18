import pytest
from sqlalchemy import text

from app.systems.manage.audit.models import SecurityEvent


@pytest.mark.integration
def test_security_events_migration_matches_runtime_catalog(integration_db) -> None:
    connection = integration_db.connection()
    assert connection.scalar(text("SELECT current_user")) == "openslate_runtime"
    assert connection.execute(
        text(
            "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, "
            "rolreplication, rolbypassrls "
            "FROM pg_roles WHERE rolname = current_user"
        )
    ).one() == (True, False, False, False, False, False)
    relation = connection.execute(
        text(
            "SELECT relrowsecurity, pg_get_userbyid(relowner) "
            "FROM pg_class WHERE oid = 'public.security_events'::regclass"
        )
    ).one()
    assert relation[0] is True
    assert relation[1] not in {"openslate_runtime", "openslate_app"}
    columns = (
        connection.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'public' AND table_name = 'security_events'"
            )
        )
        .scalars()
        .all()
    )
    assert set(columns) == {column.name for column in SecurityEvent.__table__.columns}
    assert (
        connection.scalar(
            text(
                "SELECT count(*) FROM pg_constraint "
                "WHERE conrelid = 'public.security_events'::regclass AND contype = 'f'"
            )
        )
        == 0
    )
    for role in ("openslate_app", "openslate_runtime", "anon", "authenticated", "service_role"):
        for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
            allowed = connection.scalar(
                text("SELECT has_table_privilege(:role, 'public.security_events', :privilege)"),
                {"role": role, "privilege": privilege},
            )
            assert allowed is (role.startswith("openslate_") and privilege in {"SELECT", "INSERT"})
    policies = connection.execute(
        text(
            "SELECT cmd, roles::text, qual, with_check FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = 'security_events'"
        )
    ).all()
    assert set(policies) == {
        ("SELECT", "{openslate_app}", "true", None),
        ("INSERT", "{openslate_app}", None, "true"),
    }
    timestamps = connection.execute(
        text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'users' "
            "AND column_name IN ('invitation_sent_at', 'invitation_accepted_at', "
            "'tokens_valid_after')"
        )
    ).all()
    assert set(timestamps) == {
        (name, "timestamp with time zone", "YES")
        for name in ("invitation_sent_at", "invitation_accepted_at", "tokens_valid_after")
    }
    assert connection.execute(
        text(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = 'fields' AND "
            "column_name = 'audit_redacted'"
        )
    ).one() == ("boolean", "NO", "false")
