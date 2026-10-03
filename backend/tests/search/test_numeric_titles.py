"""Numeric search titles must match existing browser Number display, before FTS."""

import pytest
from sqlalchemy.orm import Session

from app.systems.access.users.models import UserRole
from app.systems.sandbox.fields.validation import validate_field_value
from tests.rbac.support import add_user
from tests.search.test_search_routes import _client, _ids, _module, _search

OVERFLOW_MIDPOINT = 2**1024 - 2**970

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    ("kind", "value", "display"),
    [
        ("number", 1e-7, "1e-7"),
        ("number", -1e-7, "-1e-7"),
        ("number", 1e-6, "0.000001"),
        ("number", -1e-6, "-0.000001"),
        ("number", 1e20, "100000000000000000000"),
        ("number", -1e20, "-100000000000000000000"),
        ("number", 1e21, "1e+21"),
        ("number", -1e21, "-1e+21"),
        ("number", 4317.0, "4317"),
        ("number", -4317.0, "-4317"),
        ("int", 2**53 - 1, "9007199254740991"),
        ("int", 2**53 + 1, "9007199254740992"),
        ("int", 1000000000000000128, "1000000000000000100"),
        ("number", 1e23, "1e+23"),
        ("number", -1e23, "-1e+23"),
        ("number", 0.0, "0"),
        ("number", -0.0, "0"),
        ("number", float.fromhex("0x0.0000000000001p-1022"), "5e-324"),
        ("number", -float.fromhex("0x0.0000000000001p-1022"), "-5e-324"),
        ("number", float.fromhex("0x0.fffffffffffffp-1022"), "2.225073858507201e-308"),
        ("number", float.fromhex("0x1.0000000000000p-1022"), "2.2250738585072014e-308"),
        ("number", float.fromhex("0x1.fffffffffffffp+1023"), "1.7976931348623157e+308"),
        ("int", OVERFLOW_MIDPOINT - 1, "1.7976931348623157e+308"),
        ("int", OVERFLOW_MIDPOINT, None),
        ("int", -OVERFLOW_MIDPOINT, None),
    ],
)
def test_numeric_title_and_search_use_browser_display_before_pagination(
    integration_owner_db: Session, kind: str, value: int | float, display: str | None
) -> None:
    db = integration_owner_db
    actor = add_user(db, role=UserRole.ADMIN)
    module, field, rows = _module(db, [value], kind=kind)
    assert validate_field_value(field, value) == value
    db.commit()
    api = _client(db, actor)
    record = api.get(f"/api/records/{rows[0].id}")
    assert record.status_code == 200
    assert isinstance(record.json()["data"][str(field.id)], (int, float))
    expected = display if display is not None else f"Record {str(rows[0].id)[:8]}"
    result = _search(api, "record", expected, limit=1)
    assert result["pagination"] == {
        "limit": 1,
        "offset": 0,
        "count": 1,
        "total": 1,
        "has_more": False,
    }
    assert _ids(result) == {str(rows[0].id)}
    assert result["items"][0]["title"] == expected
    assert result["items"][0]["module_id"] == str(module.id)
    beyond = _search(api, "record", expected, limit=1, offset=1)
    assert beyond["items"] == [] and beyond["pagination"]["total"] == 1
