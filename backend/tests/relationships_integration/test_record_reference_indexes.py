"""Every foreign key into records has an index the delete check can use."""

import pytest
from sqlalchemy import text

from app.core.database.session import get_engine

pytestmark = pytest.mark.integration

# A foreign key into records whose referencing columns no plain (non-partial) index
# leads with: PostgreSQL then scans the whole referencing table once per deleted record.
_UNSERVED = text(
    """
    SELECT con.conrelid::regclass::text AS referencing, con.conname
    FROM pg_constraint con
    WHERE con.contype = 'f' AND con.confrelid = 'public.records'::regclass
      AND NOT EXISTS (
        SELECT 1 FROM pg_index x
        WHERE x.indrelid = con.conrelid AND x.indpred IS NULL
          AND (
            (x.indkey::int2[])[0:array_length(con.conkey, 1) - 1] @> con.conkey
            AND con.conkey @> (x.indkey::int2[])[0:array_length(con.conkey, 1) - 1]
            OR (
              SELECT attname FROM pg_attribute
              WHERE attrelid = x.indrelid AND attnum = x.indkey[0]
            ) = ANY (
              ARRAY(
                SELECT a.attname FROM unnest(con.conkey) k(attnum)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                WHERE a.attname <> 'org_id'
              )
            )
          )
      )
    ORDER BY 1, 2
    """
)


def test_every_foreign_key_into_records_has_a_usable_index() -> None:
    # Large Harbor and School on 2026-10-30: deleting 44,736 records took 53.7 s, because
    # relationship_edges had only partial indexes led by field_id, so each record's
    # source and target reference checks scanned all 80,917 edges. Purging a record with
    # relationships pays the same scan in production.
    with get_engine().connect() as connection:
        unserved = [tuple(row) for row in connection.execute(_UNSERVED)]
    assert unserved == []
