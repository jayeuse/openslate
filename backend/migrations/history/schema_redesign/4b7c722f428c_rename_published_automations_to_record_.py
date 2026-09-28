"""rename published automations to record triggers

Revision ID: 4b7c722f428c
Revises: b964cbe9fb17
Create Date: 2026-09-28 00:26:05.121417

Renames the five published automation tables, their columns, constraints and
indexes to record triggers, renames the Sandbox binding and test-run columns,
and moves the Sandbox document format to version 3.

Old designs are not converted. The shared Sandbox document becomes an empty
version-3 document, and saved versions and test runs are removed because their
stored snapshots use the version-2 format. A published Sandbox references its
versions, so the revision refuses to run while publications or record triggers
exist; reset the development application data first.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "4b7c722f428c"
down_revision: str | None = "b964cbe9fb17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = (
    ("published_automation_definitions", "record_triggers"),
    ("published_automation_conditions", "record_trigger_conditions"),
    ("published_automation_actions", "record_trigger_actions"),
    ("published_automation_events", "record_trigger_events"),
    ("published_automation_runs", "record_trigger_runs"),
)

# (table after rename, old column, new column)
COLUMNS = (
    ("record_triggers", "trigger_kind", "event_kind"),
    ("record_trigger_conditions", "automation_id", "trigger_id"),
    ("record_trigger_actions", "automation_id", "trigger_id"),
    ("record_trigger_events", "scheduled_automation_id", "scheduled_trigger_id"),
    ("record_trigger_runs", "automation_id", "trigger_id"),
    ("sandbox_test_runs", "automation_ids", "trigger_ids"),
)

# (table after rename, old constraint, new constraint). Renaming a primary key or
# unique constraint also renames its index.
CONSTRAINTS = (
    ("record_triggers", "published_automation_definitions_pkey", "record_triggers_pkey"),
    (
        "record_triggers",
        "ck_published_automation_definitions_trigger_kind",
        "ck_record_triggers_event_kind",
    ),
    ("record_triggers", "ck_published_automation_priority", "ck_record_triggers_priority"),
    (
        "record_triggers",
        "ck_published_automation_execution_position",
        "ck_record_triggers_execution_position",
    ),
    (
        "record_triggers",
        "ck_published_automation_condition_operator",
        "ck_record_triggers_condition_operator",
    ),
    (
        "record_triggers",
        "ck_published_automation_trigger_value_kind",
        "ck_record_triggers_trigger_value_kind",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_module_id_modules",
        "fk_record_triggers_module_id_modules",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_performed_by_users",
        "fk_record_triggers_performed_by_users",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_publication_id_sand_d9a2",
        "fk_record_triggers_publication_id_sandbox_publications",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_published_version_i_eb7a",
        "fk_record_triggers_published_version_id_sandbox_versions",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_publisher_id_users",
        "fk_record_triggers_publisher_id_users",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_trigger_field_id_fields",
        "fk_record_triggers_trigger_field_id_fields",
    ),
    (
        "record_triggers",
        "fk_published_automation_definitions_trigger_value_field_5a75",
        "fk_record_triggers_trigger_value_field_id_fields",
    ),
    (
        "record_trigger_conditions",
        "published_automation_conditions_pkey",
        "record_trigger_conditions_pkey",
    ),
    (
        "record_trigger_conditions",
        "ck_published_automation_conditions_operator",
        "ck_record_trigger_conditions_operator",
    ),
    (
        "record_trigger_conditions",
        "ck_published_automation_conditions_position",
        "ck_record_trigger_conditions_position",
    ),
    (
        "record_trigger_conditions",
        "ck_published_automation_conditions_value_kind",
        "ck_record_trigger_conditions_value_kind",
    ),
    (
        "record_trigger_conditions",
        "fk_published_automation_conditions_automation_id_publis_5dac",
        "fk_record_trigger_conditions_trigger_id_record_triggers",
    ),
    (
        "record_trigger_conditions",
        "fk_published_automation_conditions_field_id_fields",
        "fk_record_trigger_conditions_field_id_fields",
    ),
    (
        "record_trigger_conditions",
        "fk_published_automation_conditions_performed_by_users",
        "fk_record_trigger_conditions_performed_by_users",
    ),
    (
        "record_trigger_conditions",
        "fk_published_automation_conditions_value_field_id_fields",
        "fk_record_trigger_conditions_value_field_id_fields",
    ),
    ("record_trigger_actions", "published_automation_actions_pkey", "record_trigger_actions_pkey"),
    (
        "record_trigger_actions",
        "ck_published_automation_actions_supported_kind",
        "ck_record_trigger_actions_supported_kind",
    ),
    (
        "record_trigger_actions",
        "ck_published_automation_actions_position",
        "ck_record_trigger_actions_position",
    ),
    (
        "record_trigger_actions",
        "ck_published_automation_actions_value_kind",
        "ck_record_trigger_actions_value_kind",
    ),
    (
        "record_trigger_actions",
        "fk_published_automation_actions_automation_id_published_7fbe",
        "fk_record_trigger_actions_trigger_id_record_triggers",
    ),
    (
        "record_trigger_actions",
        "fk_published_automation_actions_performed_by_users",
        "fk_record_trigger_actions_performed_by_users",
    ),
    (
        "record_trigger_actions",
        "fk_published_automation_actions_target_field_id_fields",
        "fk_record_trigger_actions_target_field_id_fields",
    ),
    (
        "record_trigger_actions",
        "fk_published_automation_actions_value_field_id_fields",
        "fk_record_trigger_actions_value_field_id_fields",
    ),
    ("record_trigger_events", "published_automation_events_pkey", "record_trigger_events_pkey"),
    (
        "record_trigger_events",
        "uq_published_automation_events_schedule_key",
        "uq_record_trigger_events_schedule_key",
    ),
    *(
        (
            "record_trigger_events",
            f"ck_published_automation_events_{suffix}",
            f"ck_record_trigger_events_{suffix}",
        )
        for suffix in (
            "attempt_count",
            "budget",
            "depth",
            "kind",
            "lease",
            "root_depth",
            "schedule_progress",
            "state",
            "subject",
        )
    ),
    (
        "record_trigger_events",
        "fk_published_automation_events_module_id_modules",
        "fk_record_trigger_events_module_id_modules",
    ),
    (
        "record_trigger_events",
        "fk_published_automation_events_performed_by_users",
        "fk_record_trigger_events_performed_by_users",
    ),
    (
        "record_trigger_events",
        "fk_published_automation_events_record_id_records",
        "fk_record_trigger_events_record_id_records",
    ),
    (
        "record_trigger_events",
        "fk_published_automation_events_root_event_id_published__b646",
        "fk_record_trigger_events_root_event_id_record_trigger_events",
    ),
    (
        "record_trigger_events",
        "fk_published_automation_events_scheduled_automation_id__c0a6",
        "fk_record_trigger_events_scheduled_trigger_id_record_triggers",
    ),
    ("record_trigger_runs", "published_automation_runs_pkey", "record_trigger_runs_pkey"),
    (
        "record_trigger_runs",
        "ck_published_automation_runs_state",
        "ck_record_trigger_runs_state",
    ),
    (
        "record_trigger_runs",
        "uq_published_automation_runs_event_automation",
        "uq_record_trigger_runs_event_trigger",
    ),
    (
        "record_trigger_runs",
        "fk_published_automation_runs_automation_id_published_au_b175",
        "fk_record_trigger_runs_trigger_id_record_triggers",
    ),
    (
        "record_trigger_runs",
        "fk_published_automation_runs_event_id_published_automat_96cd",
        "fk_record_trigger_runs_event_id_record_trigger_events",
    ),
    (
        "record_trigger_runs",
        "fk_published_automation_runs_performed_by_users",
        "fk_record_trigger_runs_performed_by_users",
    ),
    ("sandbox_bindings", "uq_sandbox_bindings_automation_id", "uq_sandbox_bindings_trigger_id"),
    (
        "sandbox_bindings",
        "fk_sandbox_bindings_automation_id_published_automation__4bd5",
        "fk_sandbox_bindings_trigger_id_record_triggers",
    ),
)

# Indexes that do not belong to a constraint: (old, new).
INDEXES = (
    ("ix_published_automation_definitions_module", "ix_record_triggers_module"),
    ("ix_published_automation_definitions_module_id", "ix_record_triggers_module_id"),
    (
        "ix_published_automation_definitions_publication_id",
        "ix_record_triggers_publication_id",
    ),
    (
        "ix_published_automation_definitions_published_version_id",
        "ix_record_triggers_published_version_id",
    ),
    ("ix_published_automation_definitions_publisher_id", "ix_record_triggers_publisher_id"),
    (
        "ix_published_automation_definitions_trigger_field_id",
        "ix_record_triggers_trigger_field_id",
    ),
    (
        "ix_published_automation_definitions_trigger_value_field_id",
        "ix_record_triggers_trigger_value_field_id",
    ),
    (
        "ix_published_automation_conditions_automation_id",
        "ix_record_trigger_conditions_trigger_id",
    ),
    ("ix_published_automation_conditions_field_id", "ix_record_trigger_conditions_field_id"),
    (
        "ix_published_automation_conditions_value_field_id",
        "ix_record_trigger_conditions_value_field_id",
    ),
    (
        "uq_published_automation_conditions_position_active",
        "uq_record_trigger_conditions_position_active",
    ),
    ("ix_published_automation_actions_automation_id", "ix_record_trigger_actions_trigger_id"),
    (
        "ix_published_automation_actions_target_field_id",
        "ix_record_trigger_actions_target_field_id",
    ),
    (
        "ix_published_automation_actions_value_field_id",
        "ix_record_trigger_actions_value_field_id",
    ),
    (
        "uq_published_automation_actions_position_active",
        "uq_record_trigger_actions_position_active",
    ),
    ("ix_published_automation_events_due", "ix_record_trigger_events_due"),
    ("ix_published_automation_events_module_id", "ix_record_trigger_events_module_id"),
    ("ix_published_automation_events_record_id", "ix_record_trigger_events_record_id"),
    ("ix_published_automation_events_root_event_id", "ix_record_trigger_events_root_event_id"),
    (
        "ix_published_automation_events_scheduled_automation_id",
        "ix_record_trigger_events_scheduled_trigger_id",
    ),
    ("ix_published_automation_runs_automation_id", "ix_record_trigger_runs_trigger_id"),
    ("ix_published_automation_runs_created", "ix_record_trigger_runs_created"),
)

BINDING_KIND_CHECK = "kind IN ('department', 'module', 'field', 'relationship', '{kind}')"
BINDING_TARGET_CHECK = (
    "(kind = 'department' AND department_id IS NOT NULL "
    "AND module_id IS NULL AND field_id IS NULL AND {column} IS NULL) "
    "OR (kind = 'module' AND department_id IS NULL "
    "AND module_id IS NOT NULL AND field_id IS NULL AND {column} IS NULL) "
    "OR (kind IN ('field', 'relationship') AND department_id IS NULL "
    "AND module_id IS NULL AND field_id IS NOT NULL AND {column} IS NULL) "
    "OR (kind = '{kind}' AND department_id IS NULL "
    "AND module_id IS NULL AND field_id IS NULL AND {column} IS NOT NULL)"
)

EMPTY_DOCUMENTS = {
    2: (
        '{"automations":[],"design":{"departments":[],"layout":{},"modules":[],'
        '"relationships":[]},"kind":"openslate-sandbox","scenarios":[],"schemaVersion":2}',
        "34d294fb849433b5b53deb50502a21d22ef2e5383b6d93de0eb9cb21ee6d127f",
        150,
    ),
    3: (
        '{"design":{"departments":[],"layout":{},"modules":[],"relationships":[]},'
        '"kind":"openslate-sandbox","scenarios":[],"schemaVersion":3,"triggers":[]}',
        "1c8f69ffbddcb2aaa1fdbafbb6e10aa2e31a57630e4b0e5f11d50dc9affa3356",
        147,
    ),
}


def _refuse_published_sandbox(trigger_table: str) -> None:
    op.execute(
        f"""
        DO $guard$
        BEGIN
            IF EXISTS (SELECT 1 FROM public.sandbox_publications)
               OR EXISTS (SELECT 1 FROM public.{trigger_table}) THEN
                RAISE EXCEPTION 'The Sandbox has published data in the old document format.'
                    USING HINT = 'Reset the development application data, then run the '
                                 'migration again. Old designs are not converted.',
                          ERRCODE = 'object_not_in_prerequisite_state';
            END IF;
        END
        $guard$;
        """
    )


def _clear_saved_designs() -> None:
    """Remove stored snapshots and test evidence that use the replaced document format."""

    op.execute("DELETE FROM public.sandbox_test_runs")
    op.execute("UPDATE public.sandbox_versions SET source_version_id = NULL")
    op.execute("DELETE FROM public.sandbox_versions")


def _replace_document(schema_version: int) -> None:
    document, content_hash, byte_count = EMPTY_DOCUMENTS[schema_version]
    op.drop_constraint("ck_sandbox_documents_schema_version", "sandbox_documents", type_="check")
    op.execute(
        sa.text(
            "UPDATE public.sandbox_documents SET schema_version = :version, "
            "document = CAST(:document AS jsonb), content_hash = :content_hash, "
            "byte_count = :byte_count, performed_by = NULL, "
            "updated_at = now()"
        ).bindparams(
            version=schema_version,
            document=document,
            content_hash=content_hash,
            byte_count=byte_count,
        )
    )
    op.create_check_constraint(
        "ck_sandbox_documents_schema_version",
        "sandbox_documents",
        f"schema_version = {schema_version}",
    )
    op.alter_column(
        "sandbox_documents", "schema_version", server_default=sa.text(str(schema_version))
    )


def _rename_objects(*, forward: bool) -> None:
    def pair(old: str, new: str) -> tuple[str, str]:
        return (old, new) if forward else (new, old)

    tables = TABLES if forward else tuple(reversed(TABLES))
    for old, new in tables:
        source, target = pair(old, new)
        op.rename_table(source, target)
    table_names = {new: new if forward else old for old, new in TABLES}
    for table, old, new in COLUMNS:
        source, target = pair(old, new)
        op.alter_column(table_names.get(table, table), source, new_column_name=target)
    for table, old, new in CONSTRAINTS:
        source, target = pair(old, new)
        op.execute(
            f"ALTER TABLE public.{table_names.get(table, table)} "
            f"RENAME CONSTRAINT {source} TO {target}"
        )
    for old, new in INDEXES:
        source, target = pair(old, new)
        op.execute(f"ALTER INDEX public.{source} RENAME TO {target}")


def _replace_binding_checks(*, kind: str, column: str, previous_kind: str) -> None:
    op.drop_constraint("ck_sandbox_bindings_kind", "sandbox_bindings", type_="check")
    op.drop_constraint(
        "ck_sandbox_bindings_exactly_one_live_target", "sandbox_bindings", type_="check"
    )
    op.execute(
        sa.text(
            "UPDATE public.sandbox_bindings SET kind = :kind WHERE kind = :previous"
        ).bindparams(kind=kind, previous=previous_kind)
    )
    op.create_check_constraint(
        "ck_sandbox_bindings_kind", "sandbox_bindings", BINDING_KIND_CHECK.format(kind=kind)
    )
    op.create_check_constraint(
        "ck_sandbox_bindings_exactly_one_live_target",
        "sandbox_bindings",
        BINDING_TARGET_CHECK.format(kind=kind, column=column),
    )


def upgrade() -> None:
    _refuse_published_sandbox("published_automation_definitions")
    _clear_saved_designs()
    _replace_document(3)
    op.create_check_constraint(
        "ck_sandbox_versions_schema_version",
        "sandbox_versions",
        "snapshot ->> 'schemaVersion' = '3'",
    )
    op.alter_column("sandbox_bindings", "automation_id", new_column_name="trigger_id")
    _rename_objects(forward=True)
    _replace_binding_checks(kind="trigger", column="trigger_id", previous_kind="automation")


def downgrade() -> None:
    _refuse_published_sandbox("record_triggers")
    op.drop_constraint("ck_sandbox_versions_schema_version", "sandbox_versions", type_="check")
    _clear_saved_designs()
    _replace_document(2)
    _rename_objects(forward=False)
    op.alter_column("sandbox_bindings", "trigger_id", new_column_name="automation_id")
    _replace_binding_checks(kind="automation", column="automation_id", previous_kind="trigger")
