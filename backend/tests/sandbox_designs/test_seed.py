"""Sandbox seed and foreign-key contracts for the fresh Supabase baseline."""

import json
from uuid import UUID

import pytest
from sqlalchemy import text

from app.systems.sandbox.designs.defaults import EMPTY_SANDBOX_DOCUMENT, empty_document
from app.systems.sandbox.designs.validation import validate_document


def test_default_document_contains_no_placeholder_entities() -> None:
    seed = empty_document()

    assert seed.design.departments == []
    assert seed.design.modules == []
    assert seed.design.relationships == []
    assert seed.design.layout == {}
    assert seed.triggers == []
    assert seed.scenarios == []


def test_empty_document_round_trips_through_the_v2_contract() -> None:
    seed = empty_document()
    restored = type(seed).model_validate(seed.model_dump(by_alias=True, mode="json"))

    assert validate_document(restored) == []
    assert json.loads(json.dumps(EMPTY_SANDBOX_DOCUMENT)) == seed.model_dump(
        by_alias=True, mode="json", exclude_none=True
    )


@pytest.mark.integration
def test_fresh_baseline_seeds_only_the_empty_shared_document(integration_owner_db) -> None:
    rows = integration_owner_db.connection().execute(
        text(
            "SELECT id, schema_version, revision, document, content_hash, byte_count "
            "FROM public.sandbox_documents WHERE singleton_key"
        )
    ).mappings().all()

    assert len(rows) == 1
    assert rows[0] == {
        "id": UUID("00000000-0000-7000-8000-000000000005"),
        "schema_version": 3,
        "revision": 1,
        "document": EMPTY_SANDBOX_DOCUMENT,
        "content_hash": "1c8f69ffbddcb2aaa1fdbafbb6e10aa2e31a57630e4b0e5f11d50dc9affa3356",
        "byte_count": 147,
    }


@pytest.mark.integration
def test_fresh_baseline_installs_sandbox_audit_and_source_foreign_keys(
    integration_owner_db,
) -> None:
    connection = integration_owner_db.connection()
    for table in ("sandbox_documents", "sandbox_versions"):
        constraint = connection.execute(
            text(
                "SELECT referenced.relname, fk.confdeltype "
                "FROM pg_constraint AS fk "
                "JOIN pg_class AS referenced ON referenced.oid = fk.confrelid "
                "WHERE fk.conrelid = to_regclass(:table) "
                "AND fk.conname = :constraint"
            ),
            {"table": f"public.{table}", "constraint": f"fk_{table}_performed_by_users"},
        ).one_or_none()
        assert constraint == ("users", "n")

    source_version = connection.execute(
        text(
            "SELECT referenced.relname, fk.confdeltype "
            "FROM pg_constraint AS fk "
            "JOIN pg_class AS referenced ON referenced.oid = fk.confrelid "
            "WHERE fk.conrelid = 'public.sandbox_versions'::regclass "
            "AND fk.conname = 'fk_sandbox_versions_source_version_id_sandbox_versions'"
        )
    ).one_or_none()
    assert source_version == ("sandbox_versions", "r")
