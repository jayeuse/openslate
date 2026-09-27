"""Record triggers replace the published automation names everywhere."""

import json

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.main import create_app

OLD_NAME = "%automation%"


def test_api_contract_has_no_automation_names() -> None:
    contract = json.dumps(create_app().openapi()).lower()

    assert "automation" not in contract
    assert '"/api/sandbox/trigger-runs"' in contract


@pytest.mark.integration
def test_application_schema_has_no_automation_names(integration_owner_db: Session) -> None:
    connection = integration_owner_db.connection()
    leftovers = connection.execute(
        text(
            """
            SELECT 'relation', c.relname
              FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname ILIKE :old
            UNION ALL
            SELECT 'column', c.relname || '.' || a.attname
              FROM pg_attribute AS a
              JOIN pg_class AS c ON c.oid = a.attrelid
              JOIN pg_namespace AS n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
               AND NOT a.attisdropped AND a.attname ILIKE :old
            UNION ALL
            SELECT 'constraint', con.conname
              FROM pg_constraint AS con JOIN pg_namespace AS n ON n.oid = con.connamespace
             WHERE n.nspname = 'public'
               AND (con.conname ILIKE :old OR pg_get_constraintdef(con.oid) ILIKE :old)
            UNION ALL
            SELECT 'index', indexname
              FROM pg_indexes
             WHERE schemaname = 'public' AND (indexname ILIKE :old OR indexdef ILIKE :old)
            UNION ALL
            SELECT 'function', p.proname
              FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND (p.proname ILIKE :old OR p.prosrc ILIKE :old)
            UNION ALL
            SELECT 'trigger', t.tgname
              FROM pg_trigger AS t
              JOIN pg_class AS c ON c.oid = t.tgrelid
              JOIN pg_namespace AS n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND t.tgname ILIKE :old
            """
        ),
        {"old": OLD_NAME},
    ).all()

    assert leftovers == []
