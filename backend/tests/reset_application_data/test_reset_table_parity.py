"""The local reset must know every application table the ORM defines."""

import app.core.database.model_registry  # noqa: F401
from app.core.database.base import Base
from operations.reset import models as reset_models


def test_reset_tables_match_every_orm_table() -> None:
    orm_tables = set(Base.metadata.tables)
    assert set(reset_models.APPLICATION_TABLES) == orm_tables
    for table in reset_models.APPLICATION_TABLES:
        assert f"public.{table}" in reset_models._LOCK_APPLICATION_STATEMENT
    # Every organization and all of its rows go; nothing is restored afterwards.
    assert set(reset_models.DELETE_ORDER) == set(reset_models.NON_PRESERVED_TABLES)
    assert len(reset_models.DELETE_ORDER) == len(set(reset_models.DELETE_ORDER))
    assert reset_models.DELETE_ORDER[-1] == "organizations"


def test_reset_deletes_saved_charts_after_widgets_and_before_their_sources() -> None:
    order = reset_models.DELETE_ORDER
    assert "charts" in reset_models.NON_PRESERVED_TABLES
    assert order.index("dashboard_widgets") < order.index("charts")
    for source_table in ("modules", "departments"):
        assert order.index("charts") < order.index(source_table)


def test_reset_releases_file_links_before_inventory_and_conversation_parents() -> None:
    order = reset_models.DELETE_ORDER
    for link in (
        "comms_message_attachments", "board_attachments", "board_post_revision_attachments",
    ):
        assert order.index(link) < order.index("files")
    assert order.index("files") < order.index("comms_conversations")
    assert order.index("comms_conversations") < order.index("comms_categories")


def test_reset_deletes_every_restricting_child_before_its_parent() -> None:
    # A restrictive reference to a row deleted earlier aborts the whole reset, for
    # example a link-preview job that still points at its Comms message.
    order = {table: index for index, table in enumerate(reset_models.DELETE_ORDER)}
    # The reset clears these two references before it deletes anything.
    cleared_first = {("organizations", "logo_file_id"), ("modules", "title_field_id")}
    late_children = sorted(
        (child.name, key.name)
        for child in Base.metadata.sorted_tables
        for key in child.foreign_key_constraints
        if child.name in order
        and key.referred_table.name in order
        and key.referred_table is not child
        and (key.ondelete or "").upper() not in {"CASCADE", "SET NULL"}
        and not any((child.name, column.name) in cleared_first for column in key.columns)
        and order[child.name] > order[key.referred_table.name]
    )
    assert late_children == []
