"""Preserve backup/release history and fence reset against unreconciled claims."""

from __future__ import annotations

import json
import re
from typing import Any
from uuid import UUID

from operations.reset.models import BackupSnapshot, ResetError

_TABLES = ("backup_policies", "backup_runs", "backup_export_operations", "update_statuses")
_QUEUED_PREDICATE = (
    "installation_id = %s AND state = 'queued' AND started_at IS NULL AND claim_id IS NULL"
)


def _rows(connection: Any, statement: str, params: tuple[object, ...] = ()) -> list[Any]:
    with connection.cursor() as cursor:
        cursor.execute(statement, params)
        return list(cursor.fetchall())


def _installation(connection: Any) -> str:
    # The CLI has already admitted this connection against InstanceTarget.cluster_name.
    rows = _rows(connection, "SELECT current_setting('cluster_name', true)")
    value = rows[0][0] if len(rows) == 1 and len(rows[0]) == 1 else None
    if not isinstance(value, str) or re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,62}", value) is None:
        raise ResetError("The admitted reset installation identity is unavailable")
    return value


def require_no_unresolved_backup(connection: Any, installation_id: str) -> None:
    """Check durable claims while the caller holds the appropriate reset locks."""
    if _installation(connection) != installation_id:
        raise ResetError("The reset installation identity changed")
    rows = _rows(
        connection,
        "SELECT count(*) FROM public.backup_runs WHERE installation_id = %s "
        "AND started_at IS NOT NULL AND reconciled_at IS NULL",
        (installation_id,),
    )
    count = rows[0][0] if len(rows) == 1 and len(rows[0]) == 1 else None
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ResetError("Unable to verify current backup claims")
    if count:
        raise ResetError("Current backup requires reconciliation before reset")
    checks = (
        (
            "SELECT count(*) FROM public.backup_export_operations "
            "WHERE installation_id = %s AND state = 'preparing'",
            (installation_id,),
            "Current export requires reconciliation before reset",
        ),
        (
            "SELECT count(*) FROM public.backup_runs AS source "
            "JOIN public.backup_export_operations AS export ON export.backup_run_id = source.id "
            "WHERE source.installation_id = %s AND source.state = 'queued' "
            "AND source.started_at IS NULL AND source.claim_id IS NULL "
            "AND NOT (export.installation_id = %s AND export.state = 'queued' "
            "AND export.claim_id IS NULL)",
            (installation_id, installation_id),
            "Retained export references a backup selected for reset deletion",
        ),
    )
    for statement, params, refusal in checks:
        rows = _rows(connection, statement, params)
        count = rows[0][0] if len(rows) == 1 and len(rows[0]) == 1 else None
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ResetError("Unable to verify preserved export claims")
        if count:
            raise ResetError(refusal)


def read_backup_snapshot(connection: Any) -> BackupSnapshot:
    """Freeze every metadata column, including future columns, without reporting values."""
    installation_id = _installation(connection)
    require_no_unresolved_backup(connection, installation_id)
    tables: list[tuple[str, tuple[str, ...]]] = []
    for table in _TABLES:
        rows = _rows(
            connection, f"SELECT to_jsonb(source) FROM public.{table} AS source ORDER BY id"
        )
        serialized: list[str] = []
        for row in rows:
            if len(row) != 1 or not isinstance(row[0], dict):
                raise ResetError("Unable to snapshot preserved backup metadata")
            try:
                UUID(row[0]["id"])
                serialized.append(json.dumps(row[0], sort_keys=True, separators=(",", ":")))
            except (KeyError, TypeError, ValueError):
                raise ResetError("Unable to snapshot preserved backup metadata") from None
        tables.append((table, tuple(sorted(serialized))))
    return BackupSnapshot(installation_id, tuple(tables))


def delete_unclaimed_backup_queue(connection: Any, installation_id: str) -> None:
    """Discard only this admitted dev/test installation's never-started requests."""
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM public.backup_export_operations "
            "WHERE installation_id = %s AND state = 'queued' AND claim_id IS NULL",
            (installation_id,),
        )
        cursor.execute(
            "UPDATE public.backup_export_operations SET admission_digest = NULL, "
            "admission_actor_id = NULL, admission_session_id = NULL, admission_expires_at = NULL "
            "WHERE admission_digest IS NOT NULL"
        )
        cursor.execute(
            f"DELETE FROM public.backup_runs WHERE {_QUEUED_PREDICATE}", (installation_id,)
        )


def validate_backup_preservation(
    connection: Any, snapshot: BackupSnapshot, preserved_admin_id: UUID
) -> None:
    """Prove exact retained rows; only attribution to deleted profiles can become null."""
    actual = read_backup_snapshot(connection)
    expected: list[tuple[str, tuple[str, ...]]] = []
    for table, serialized in snapshot.rows:
        retained: list[str] = []
        for value in serialized:
            row = json.loads(value)
            if (
                table == "backup_runs"
                and row["installation_id"] == snapshot.installation_id
                and row["state"] == "queued"
                and row["started_at"] is None
                and row["claim_id"] is None
            ):
                continue
            if table == "backup_export_operations":
                if (
                    row["installation_id"] == snapshot.installation_id
                    and row["state"] == "queued"
                    and row["claim_id"] is None
                ):
                    continue
                for field in (
                    "admission_digest",
                    "admission_actor_id",
                    "admission_session_id",
                    "admission_expires_at",
                ):
                    row[field] = None
            for attribution in ("requester_id", "performed_by"):
                if attribution in row and row[attribution] != str(preserved_admin_id):
                    row[attribution] = None
            retained.append(json.dumps(row, sort_keys=True, separators=(",", ":")))
        expected.append((table, tuple(sorted(retained))))
    if actual.installation_id != snapshot.installation_id or actual.rows != tuple(expected):
        raise ResetError("Reset postcondition failed: preserved backup metadata changed")
