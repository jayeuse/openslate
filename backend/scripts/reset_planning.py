"""Read-only validation and reset-plan construction."""

import hashlib
import json
import os
import shlex
import subprocess
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from typing import Any
from uuid import UUID

from sqlalchemy.engine import make_url

if __package__:
    from .reset_models import (  # type: ignore[import-not-found]
        _ALEMBIC_HEAD_STATEMENT,
        _AUTH_USER_COUNT_STATEMENT,
        _AUTH_USERS_STATEMENT,
        _COUNT_STATEMENTS,
        _EFFECTIVE_ADMIN_PROFILES_STATEMENT,
        _PROFILE_DELETE_COUNTS_STATEMENT,
        _PROFILE_STATEMENT,
        _PUBLIC_TABLES_STATEMENT,
        _ROLES_STATEMENT,
        APPLICATION_TABLES,
        EXPECTED_ALEMBIC_HEAD,
        EXPECTED_DATABASE_HOST,
        EXPECTED_DATABASE_NAME,
        EXPECTED_DATABASE_PORT,
        EXPECTED_PROJECT_ID,
        AuthSnapshot,
        ProfileSnapshot,
        ResetError,
        ResetPlan,
        RoleSnapshot,
    )
else:
    from reset_models import (
        _ALEMBIC_HEAD_STATEMENT,
        _AUTH_USER_COUNT_STATEMENT,
        _AUTH_USERS_STATEMENT,
        _COUNT_STATEMENTS,
        _EFFECTIVE_ADMIN_PROFILES_STATEMENT,
        _PROFILE_DELETE_COUNTS_STATEMENT,
        _PROFILE_STATEMENT,
        _PUBLIC_TABLES_STATEMENT,
        _ROLES_STATEMENT,
        APPLICATION_TABLES,
        EXPECTED_ALEMBIC_HEAD,
        EXPECTED_DATABASE_HOST,
        EXPECTED_DATABASE_NAME,
        EXPECTED_DATABASE_PORT,
        EXPECTED_PROJECT_ID,
        AuthSnapshot,
        ProfileSnapshot,
        ResetError,
        ResetPlan,
        RoleSnapshot,
    )


def required_environment(mapping: Mapping[str, str]) -> tuple[str, str]:
    """Return the required reset settings without falling back to other URLs."""
    values: list[str] = []
    for name in ("MIGRATION_DATABASE_URL", "ADMIN_EMAIL"):
        value = mapping.get(name, "")
        if not isinstance(value, str) or not value.strip():
            raise ResetError(f"{name} is required")
        values.append(value.strip())
    return values[0], values[1].casefold()


def _validated_database_url(value: str) -> str:
    try:
        url = make_url(value)
        if url.drivername not in {"postgresql", "postgresql+psycopg"}:
            raise ValueError
        if url.host != EXPECTED_DATABASE_HOST:
            raise ValueError
        if url.port != EXPECTED_DATABASE_PORT:
            raise ValueError
        if url.database != EXPECTED_DATABASE_NAME:
            raise ValueError
        if not url.username or not url.password or url.query:
            raise ValueError
        return url.set(drivername="postgresql").render_as_string(hide_password=False)
    except Exception:
        raise ResetError("MIGRATION_DATABASE_URL must target the local Supabase database") from None


def validate_local_database_url(url: str, expected_url: str | None = None) -> None:
    """Require the exact local PostgreSQL target and, when supplied, its match."""
    normalized = _validated_database_url(url)
    if expected_url is not None and normalized != _validated_database_url(expected_url):
        raise ResetError("The migration and Supabase status database URLs do not match")


def parse_supabase_status_database_url(output: str) -> str:
    """Parse exactly one DB_URL assignment without evaluating shell input."""
    try:
        matches = [line for line in output.splitlines() if line.startswith("DB_URL=")]
        if len(matches) != 1:
            raise ValueError
        tokens = shlex.split(matches[0], comments=False, posix=True)
        if len(tokens) != 1 or not tokens[0].startswith("DB_URL="):
            raise ValueError
        value = tokens[0][len("DB_URL=") :]
        if not value:
            raise ValueError
        _validated_database_url(value)
        return value
    except ResetError:
        raise ResetError("Supabase status did not provide one database URL") from None
    except (AttributeError, TypeError, ValueError):
        raise ResetError("Supabase status did not provide one database URL") from None


def read_supabase_status_database_url(
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """Read the local Supabase DB_URL while keeping command output in memory."""
    path = os.environ.get("PATH")
    if not path:
        raise ResetError("PATH is required to inspect local Supabase status")
    try:
        result = run_command(
            ["supabase", "status", "-o", "env"],
            cwd=Path(__file__).resolve().parents[2],
            env={"PATH": path},
            capture_output=True,
            text=True,
            check=True,
            shell=False,
        )
        return parse_supabase_status_database_url(result.stdout)
    except ResetError:
        raise
    except Exception:
        raise ResetError("Unable to inspect local Supabase status") from None


def validate_local_project(root: Path | str) -> None:
    """Require the OpenSlate Supabase project and database port configuration."""
    config_path = Path(root) / "supabase" / "config.toml"
    try:
        with config_path.open("rb") as config_file:
            config = tomllib.load(config_file)
        database = config.get("db")
        if (
            config.get("project_id") != EXPECTED_PROJECT_ID
            or not isinstance(database, dict)
            or database.get("port") != EXPECTED_DATABASE_PORT
        ):
            raise ValueError
    except Exception:
        raise ResetError(
            "The repository is not configured for the local OpenSlate Supabase project"
        ) from None


def _normalize_email(value: object) -> str:
    if not isinstance(value, str):
        raise ResetError("The sample email is invalid")
    normalized = value.strip().casefold()
    if not normalized:
        raise ResetError("The sample email is required")
    return normalized


def _optional_normalized_email(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().casefold()
    return normalized or None


def _execute(connection: Any, statement: str, params: tuple[object, ...] | None = None) -> Any:
    with connection.cursor() as cursor:
        if params is None:
            cursor.execute(statement)
        else:
            cursor.execute(statement, params)
        return cursor


def _fetchall(
    connection: Any, statement: str, params: tuple[object, ...] | None = None
) -> list[tuple[object, ...]]:
    with connection.cursor() as cursor:
        if params is None:
            cursor.execute(statement)
        else:
            cursor.execute(statement, params)
        return list(cursor.fetchall())


def _single_value(
    connection: Any, statement: str, params: tuple[object, ...] | None = None
) -> object:
    rows = _fetchall(connection, statement, params)
    if len(rows) != 1 or len(rows[0]) != 1:
        raise ResetError("The database returned an unexpected validation result")
    return rows[0][0]


def _as_uuid(value: object) -> UUID:
    try:
        return value if isinstance(value, UUID) else UUID(str(value))
    except (AttributeError, TypeError, ValueError):
        raise ResetError("The database contains an invalid preserved identity") from None


def _read_public_table_names(connection: Any) -> set[str]:
    rows = _fetchall(connection, _PUBLIC_TABLES_STATEMENT, ("public",))
    if any(len(row) != 1 or not isinstance(row[0], str) for row in rows):
        raise ResetError("The public application table allowlist has drifted")
    table_names = {row[0] for row in rows if isinstance(row[0], str)}
    if "alembic_version" in table_names:
        table_names.remove("alembic_version")
    if table_names != set(APPLICATION_TABLES):
        raise ResetError("The public application table allowlist has drifted")
    return table_names


def _read_alembic_head(connection: Any) -> str:
    rows = _fetchall(connection, _ALEMBIC_HEAD_STATEMENT)
    if len(rows) != 1 or len(rows[0]) != 1 or not isinstance(rows[0][0], str):
        raise ResetError("The database migration head is invalid")
    head = rows[0][0]
    if head != EXPECTED_ALEMBIC_HEAD:
        raise ResetError("The database migration head is not supported")
    return head


def _read_auth_users(connection: Any) -> tuple[int, tuple[AuthSnapshot, ...]]:
    count_value = _single_value(connection, _AUTH_USER_COUNT_STATEMENT)
    try:
        count = int(str(count_value))
    except (TypeError, ValueError):
        raise ResetError("The Auth user count is invalid") from None

    snapshots: list[AuthSnapshot] = []
    for row in _fetchall(connection, _AUTH_USERS_STATEMENT):
        if len(row) < 4:
            raise ResetError("The Auth identity snapshot is invalid")
        snapshots.append(
            AuthSnapshot(
                id=_as_uuid(row[0]),
                email=row[1],
                email_confirmed_at=row[2],
                banned_until=row[3],
                deleted_at=row[4] if len(row) > 4 else None,
            )
        )
    snapshots.sort(key=lambda snapshot: str(snapshot.id))
    if len({snapshot.id for snapshot in snapshots}) != len(snapshots):
        raise ResetError("The Auth identity snapshot is ambiguous")
    if count != len(snapshots):
        raise ResetError("The Auth user count changed while the plan was read")
    return count, tuple(snapshots)


def _read_profile(connection: Any, user_id: UUID) -> ProfileSnapshot:
    rows = _fetchall(connection, _PROFILE_STATEMENT, (user_id,))
    if len(rows) != 1 or len(rows[0]) != 10:
        raise ResetError("The administrator profile is missing or ambiguous")
    row = rows[0]
    return ProfileSnapshot(
        id=_as_uuid(row[0]),
        created_at=row[1],
        deleted_at=row[2],
        is_deleted=row[3],
        updated_at=row[4],
        performed_by=row[5],
        email=row[6],
        username=row[7],
        status=row[8],
        role_id=_as_uuid(row[9]),
    )


def _read_roles(connection: Any) -> tuple[RoleSnapshot, ...]:
    snapshots: list[RoleSnapshot] = []
    for row in _fetchall(connection, _ROLES_STATEMENT):
        if len(row) != 8:
            raise ResetError("The role snapshot is invalid")
        snapshots.append(
            RoleSnapshot(
                id=_as_uuid(row[0]),
                created_at=row[1],
                deleted_at=row[2],
                is_deleted=row[3],
                updated_at=row[4],
                performed_by=row[5],
                role=row[6],
                permissions=row[7],
            )
        )
    if len({snapshot.id for snapshot in snapshots}) != len(snapshots):
        raise ResetError("The role snapshot is ambiguous")
    return tuple(sorted(snapshots, key=lambda snapshot: str(snapshot.id)))


def _read_effective_admin_profiles(connection: Any, preserved_id: UUID) -> tuple[UUID, ...]:
    rows = _fetchall(connection, _EFFECTIVE_ADMIN_PROFILES_STATEMENT, (preserved_id,))
    if any(len(row) != 1 for row in rows):
        raise ResetError("The effective administrator profile query is invalid")
    return tuple(_as_uuid(row[0]) for row in rows)


def _read_profile_delete_counts(connection: Any, preserved_id: UUID) -> tuple[int, int]:
    rows = _fetchall(
        connection,
        _PROFILE_DELETE_COUNTS_STATEMENT,
        (preserved_id, preserved_id),
    )
    if len(rows) != 1 or len(rows[0]) != 2:
        raise ResetError("The profile deletion counts are invalid")
    try:
        profiles_to_delete = int(str(rows[0][0]))
        inactive_admin_profiles_to_delete = int(str(rows[0][1]))
    except (TypeError, ValueError):
        raise ResetError("The profile deletion counts are invalid") from None
    if profiles_to_delete < 0 or inactive_admin_profiles_to_delete < 0:
        raise ResetError("The profile deletion counts are invalid")
    return profiles_to_delete, inactive_admin_profiles_to_delete


def _read_counts(connection: Any) -> Mapping[str, int]:
    counts: dict[str, int] = {}
    for table_name, statement in _COUNT_STATEMENTS:
        value = _single_value(connection, statement)
        try:
            count = int(str(value))
        except (TypeError, ValueError):
            raise ResetError("The application row count is invalid") from None
        if count < 0:
            raise ResetError("The application row count is invalid")
        counts[table_name] = count
    return MappingProxyType(counts)


def _stable_value(value: object) -> object:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): _stable_value(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_stable_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return isoformat()
    return str(value)


def _snapshot_payload(snapshot: object) -> dict[str, object]:
    values = getattr(snapshot, "__dataclass_fields__", None)
    field_names = values.keys() if values is not None else vars(snapshot).keys()
    return {field_name: _stable_value(getattr(snapshot, field_name)) for field_name in field_names}


def _expected_snapshot_payload(snapshot: object, preserved_admin_id: UUID) -> dict[str, object]:
    payload = _snapshot_payload(snapshot)
    performed_by = getattr(snapshot, "performed_by", None)
    if performed_by is not None:
        try:
            is_preserved_actor = _as_uuid(performed_by) == preserved_admin_id
        except ResetError:
            is_preserved_actor = False
        if not is_preserved_actor:
            payload["performed_by"] = None
    return payload


def _impact_digest(plan: ResetPlan) -> str:
    payload = {
        "sample_email": plan.sample_email,
        "counts": {name: plan.counts[name] for name in sorted(plan.counts)},
        "profiles_to_delete": plan.profiles_to_delete,
        "inactive_admin_profiles_to_delete": plan.inactive_admin_profiles_to_delete,
        "auth_user_count": plan.auth_user_count,
        "auth_identity": _snapshot_payload(plan.auth_identity),
        "auth_identities": [_snapshot_payload(item) for item in plan.auth_identities],
        "profile_before": _snapshot_payload(plan.profile_snapshot),
        "profile_expected_after": _expected_snapshot_payload(
            plan.profile_snapshot, plan.preserved_admin_id
        ),
        "admin_role_before": _snapshot_payload(plan.admin_role_snapshot),
        "admin_role_expected_after": _expected_snapshot_payload(
            plan.admin_role_snapshot, plan.preserved_admin_id
        ),
        "member_role_before": _snapshot_payload(plan.member_role_snapshot),
        "member_role_expected_after": _expected_snapshot_payload(
            plan.member_role_snapshot, plan.preserved_admin_id
        ),
        "preserved_admin_id": str(plan.preserved_admin_id),
        "preserved_admin_role_id": str(plan.preserved_admin_role_id),
        "preserved_member_role_id": str(plan.preserved_member_role_id),
        "alembic_head": plan.alembic_head,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def build_reset_plan(
    connection: Any,
    sample_email: str,
    *,
    read_profile_fn: Callable[[Any, UUID], ProfileSnapshot] = _read_profile,
    read_roles_fn: Callable[[Any], tuple[RoleSnapshot, ...]] = _read_roles,
) -> ResetPlan:
    """Read and validate all state required for a safe local reset."""
    try:
        normalized_email = _normalize_email(sample_email)
        _read_public_table_names(connection)
        alembic_head = _read_alembic_head(connection)
        auth_user_count, auth_identities = _read_auth_users(connection)

        matching_identities = [
            identity
            for identity in auth_identities
            if _optional_normalized_email(identity.email) == normalized_email
            and identity.email_confirmed_at is not None
            and identity.banned_until is None
            and identity.deleted_at is None
        ]
        if len(matching_identities) != 1:
            raise ResetError(
                "The sample email must resolve to exactly one enabled confirmed Auth user"
            )
        auth_identity = matching_identities[0]

        profile = read_profile_fn(connection, auth_identity.id)
        if (
            profile.id != auth_identity.id
            or profile.status != "active"
            or profile.is_deleted is not False
            or _optional_normalized_email(profile.email) != normalized_email
        ):
            raise ResetError("The administrator profile is not active and preserved")

        roles = read_roles_fn(connection)
        active_admin_roles = [
            role for role in roles if role.role == "admin" and role.is_deleted is False
        ]
        active_member_roles = [
            role for role in roles if role.role == "member" and role.is_deleted is False
        ]
        if len(active_admin_roles) != 1 or len(active_member_roles) != 1:
            raise ResetError("Exactly one active literal admin and member role are required")
        admin_role = active_admin_roles[0]
        member_role = active_member_roles[0]
        if admin_role.id == member_role.id or profile.role_id != admin_role.id:
            raise ResetError("The administrator profile does not reference the active admin role")

        effective_admin_profiles = _read_effective_admin_profiles(connection, auth_identity.id)
        if effective_admin_profiles:
            raise ResetError("Another effective administrator profile exists")

        profiles_to_delete, inactive_admin_profiles_to_delete = _read_profile_delete_counts(
            connection, auth_identity.id
        )
        count_values = dict(_read_counts(connection))
        count_values.update(
            profiles_to_delete=profiles_to_delete,
            inactive_admin_profiles_to_delete=inactive_admin_profiles_to_delete,
        )
        counts = MappingProxyType(count_values)
        plan = ResetPlan(
            sample_email=normalized_email,
            counts=counts,
            profiles_to_delete=profiles_to_delete,
            inactive_admin_profiles_to_delete=inactive_admin_profiles_to_delete,
            impact_digest="",
            preserved_admin_id=auth_identity.id,
            preserved_admin_role_id=admin_role.id,
            preserved_member_role_id=member_role.id,
            auth_user_count=auth_user_count,
            auth_identity=auth_identity,
            auth_identities=auth_identities,
            profile_snapshot=profile,
            admin_role_snapshot=admin_role,
            member_role_snapshot=member_role,
            alembic_head=alembic_head,
        )
        return replace(plan, impact_digest=_impact_digest(plan))
    except ResetError:
        raise
    except Exception:
        raise ResetError("Unable to validate application data") from None
