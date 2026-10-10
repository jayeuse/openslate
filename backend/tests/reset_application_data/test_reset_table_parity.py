"""The local reset must know every application table the ORM defines."""

import app.core.database.model_registry  # noqa: F401
from app.core.database.base import Base
from operations.reset import models as reset_models


def test_reset_tables_match_every_orm_table() -> None:
    orm_tables = set(Base.metadata.tables)
    assert set(reset_models.APPLICATION_TABLES) == orm_tables
    for table in reset_models.APPLICATION_TABLES:
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    assert set(reset_models.DELETE_ORDER) == set(reset_models.NON_PRESERVED_TABLES) | {
        "boards",
        "sandbox_versions",
    }


def test_reset_deletes_saved_charts_after_widgets_and_before_their_sources() -> None:
    order = reset_models.DELETE_ORDER
    assert "charts" in reset_models.NON_PRESERVED_TABLES
    for widget_table in ("board_widgets", "dashboard_widgets"):
        assert order.index(widget_table) < order.index("charts")
    for source_table in ("modules", "departments"):
        assert order.index("charts") < order.index(source_table)
