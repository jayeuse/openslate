from typing import Any

from sqlalchemy import CheckConstraint, MetaData, Table
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.sql.elements import conv

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "%(table_name)s_pkey",
}

# The soft-delete pair: a deleted row has a deletion time and a live row has none.
DELETION_STATE_CHECK = (
    "(is_deleted AND deleted_at IS NOT NULL) OR (NOT is_deleted AND deleted_at IS NULL)"
)


def deletion_state_name(table_name: str) -> str:
    return f"ck_{table_name}_deletion_state"


def add_deletion_state_check(table: Table) -> None:
    """Give a table with both soft-delete columns the shared pair check, once.

    The name is final (``conv``): a generic ``ck`` naming convention would also rename
    every explicitly named check constraint in the models.
    """
    if not {"is_deleted", "deleted_at"} <= set(table.c.keys()):
        return
    name = deletion_state_name(table.name)
    if any(constraint.name == name for constraint in table.constraints):
        return
    table.append_constraint(CheckConstraint(DELETION_STATE_CHECK, name=conv(name)))


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)

    def __init_subclass__(cls, **kwargs: Any) -> None:
        # Runs after declarative mapping, so every mapped table, current or future,
        # gets the check whether or not its model also defines ``__table_args__``.
        super().__init_subclass__(**kwargs)
        table = cls.__dict__.get("__table__")
        if isinstance(table, Table):
            add_deletion_state_check(table)
