"""Stack-free contracts of the sample-organization removal."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from app.core.database.base import Base
from operations.reset.models import ResetError
from operations.reset.organization import (
    NULL_ORGANIZATION_DELETIONS,
    build_organization_removal_plan,
)


@pytest.mark.parametrize(
    "slugs",
    [
        ("harbor",),  # not a sample organization
        ("sample-harbor", "reset-second"),  # one non-sample slug refuses the pair
        ("sample-",),  # no pack key
        (),
    ],
)
def test_removal_refuses_any_organization_that_is_not_a_sample_before_reading(
    slugs: tuple[str, ...],
) -> None:
    connection = Mock()

    with pytest.raises(ResetError, match="Only sample organizations"):
        build_organization_removal_plan(
            connection,
            slugs=slugs,
            operator_email="operator@example.test",
            domains={"harbor.test"},
            auth_accounts=(),
            list_storage_keys=lambda _prefixes: (),
        )
    connection.cursor.assert_not_called()


def test_every_null_organization_row_that_restricts_an_account_is_removed_with_it() -> None:
    # A new table of this kind would otherwise refuse every removal of its accounts.
    restricting = {
        table.name
        for table in Base.metadata.sorted_tables
        if "org_id" in table.c
        and table.c.org_id.nullable
        and any(
            key.column.table.name == "users"
            and (key.ondelete or "RESTRICT").upper() in {"RESTRICT", "NO ACTION"}
            for key in table.foreign_keys
        )
    }
    assert restricting == set(NULL_ORGANIZATION_DELETIONS)
