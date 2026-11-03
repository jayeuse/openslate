"""D7: find audit and security entries by an error reference (the end of ``request_id``)."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import Query
from sqlalchemy import Text, and_, cast, func
from sqlalchemy.sql.elements import ColumnElement

_HEX = "[0-9a-fA-F]"
REFERENCE_PATTERN = (
    f"^(?:{_HEX}{{8}}|{_HEX}{{8}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{4}}-{_HEX}{{12}})$"
)
Reference = Annotated[
    str | None,
    Query(
        pattern=REFERENCE_PATTERN,
        description="The 8-character error reference or the full request ID; any case.",
    ),
]


def reference_condition(column: Any, reference: str) -> ColumnElement[bool]:
    """The 8-character suffix (an organization-scoped scan), or the full ID (indexed)."""

    value = reference.lower()
    if len(value) == 8:
        return and_(column.is_not(None), func.right(cast(column, Text), 8) == value)
    return column == UUID(value)  # type: ignore[no-any-return]
