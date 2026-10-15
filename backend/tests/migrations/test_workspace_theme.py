"""Organization theme column contract on the fresh root."""

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def test_workspace_theme_column_preserves_type_nullability_and_default(integration_owner_db):
    column = integration_owner_db.connection().execute(
        text(
            "SELECT data_type,character_maximum_length,is_nullable,column_default "
            "FROM information_schema.columns WHERE table_schema='public' "
            "AND table_name='organizations' AND column_name='theme'"
        )
    ).one()
    assert column[:3] == ("character varying", 16, "NO")
    assert column.column_default.startswith("'slate'")
