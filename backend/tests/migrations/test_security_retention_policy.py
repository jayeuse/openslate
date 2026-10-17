"""Retention bounds and narrow privileged capability on the fresh root."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

pytestmark = pytest.mark.integration
FIELDS = ("session_retention_days", "security_event_retention_days")


def test_retention_defaults_and_types(integration_owner_db):
    connection = integration_owner_db.connection()
    assert (
        connection.execute(
            text(
                "SELECT data_type,is_nullable,column_default FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name='platform_settings' "
                "AND column_name IN ('session_retention_days','security_event_retention_days') "
                "ORDER BY column_name"
            )
        ).all()
        == [("integer", "NO", "365")] * 2
    )
    row = connection.execute(
        text("SELECT session_retention_days,security_event_retention_days FROM platform_settings")
    ).one()
    assert list(row) == [365, 365]


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("value", [0, 3651, None])
def test_named_retention_bounds_reject_invalid_storage(integration_owner_db, field, value):
    connection = integration_owner_db.connection()
    with pytest.raises(IntegrityError), connection.begin_nested():
        connection.execute(
            text(f"UPDATE public.platform_settings SET {field}=:value"), {"value": value}
        )


def test_capability_catalog_is_zero_argument_owner_bound_and_narrowly_granted(integration_owner_db):
    connection = integration_owner_db.connection()
    row = connection.execute(
        text(
            "SELECT p.pronargs,p.prosecdef,p.provolatile,p.proparallel,p.proconfig, "
            "pg_get_userbyid(p.proowner),pg_get_function_result(p.oid) FROM pg_proc p "
            "WHERE p.oid='public.retain_security_events()'::regprocedure"
        )
    ).one()
    assert row[0:4] == (0, True, "v", "u")
    settings = dict(value.split("=", 1) for value in row[4])
    assert settings["search_path"] == "pg_catalog, pg_temp"
    assert settings["TimeZone"] == "UTC"
    assert row[5:] == ("openslate_owner", "integer")
    assert connection.scalar(text("SELECT to_regprocedure('pg_catalog.gen_random_uuid()')"))
    for role in ("anon", "authenticated", "service_role"):
        assert (
            connection.scalar(
                text(
                    "SELECT has_function_privilege(:role,"
                    "'public.retain_security_events()','EXECUTE')"
                ),
                {"role": role},
            )
            is False
        )
    assert (
        connection.scalar(
            text(
                "SELECT has_function_privilege('openslate_runtime', "
                "'public.retain_security_events()','EXECUTE')"
            )
        )
        is True
    )
    assert (
        connection.scalar(
            text(
                "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(p.proacl) acl "
                "WHERE p.oid='public.retain_security_events()'::regprocedure AND acl.grantee=0"
            )
        )
        == 0
    )
