"""Read-only validation and reset-plan construction for local PostgreSQL."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from typing import Any, cast
from uuid import UUID

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy.engine import make_url

from app.core.config.instance import (
    InstanceTarget,
    InstanceTargetError,
    assert_database_url,
    test_manifest_authorizes_process,
)

if __package__:
    from .reset_models import (  # type: ignore[import-not-found]
        _ACCESS_POLICY_DEFAULTS_STATEMENT,
        _ACCESS_POLICY_VERSION_STATEMENT,
        _ALEMBIC_HEAD_STATEMENT,
        _COUNT_STATEMENTS,
        _EFFECTIVE_ADMIN_PROFILES_STATEMENT,
        _PROFILE_DELETE_COUNTS_STATEMENT,
        _PROFILE_STATEMENT,
        _PROVIDER_SUBJECTS_STATEMENT,
        _PUBLIC_TABLES_STATEMENT,
        _ROLES_STATEMENT,
        _WORKSPACE_STATEMENT,
        ACCESS_POLICY_DEFAULTS_ID,
        ACCESS_POLICY_VERSION_ID,
        APPLICATION_TABLES,
        EXPECTED_DATABASE_USER,
        AccessPolicyDefaultsSnapshot,
        AccessPolicyVersionSnapshot,
        ProfileSnapshot,
        ResetError,
        ResetPlan,
        RoleSnapshot,
        WorkspaceSnapshot,
        stable_snapshot_payload,
    )
else:
    from reset_models import (
        _ACCESS_POLICY_DEFAULTS_STATEMENT,
        _ACCESS_POLICY_VERSION_STATEMENT,
        _ALEMBIC_HEAD_STATEMENT,
        _COUNT_STATEMENTS,
        _EFFECTIVE_ADMIN_PROFILES_STATEMENT,
        _PROFILE_DELETE_COUNTS_STATEMENT,
        _PROFILE_STATEMENT,
        _PROVIDER_SUBJECTS_STATEMENT,
        _PUBLIC_TABLES_STATEMENT,
        _ROLES_STATEMENT,
        _WORKSPACE_STATEMENT,
        ACCESS_POLICY_DEFAULTS_ID,
        ACCESS_POLICY_VERSION_ID,
        APPLICATION_TABLES,
        EXPECTED_DATABASE_USER,
        AccessPolicyDefaultsSnapshot,
        AccessPolicyVersionSnapshot,
        ProfileSnapshot,
        ResetError,
        ResetPlan,
        RoleSnapshot,
        WorkspaceSnapshot,
        stable_snapshot_payload,
    )


def required_environment(mapping: Mapping[str, str]) -> tuple[str, str]:
    """Return required reset settings without accepting alternate database URLs."""
    values: list[str] = []
    for name in ("MIGRATION_DATABASE_URL", "ADMIN_EMAIL"):
        value = mapping.get(name, "")
        if not isinstance(value, str) or not value.strip():
            raise ResetError(f"{name} is required")
        values.append(value.strip())
    return values[0], values[1].casefold()


def _validated_database_url(
    value: str,
    target: InstanceTarget | None = None,
    *,
    runner_manifest_authorized: bool = False,
) -> str:
    try:
        url = make_url(value)
        if target is not None:
            assert_database_url(value, target, expected_user=EXPECTED_DATABASE_USER)
        elif not runner_manifest_authorized or not test_manifest_authorizes_process(
            value, EXPECTED_DATABASE_USER
        ):
            raise ValueError
        if (
            url.drivername not in {"postgresql", "postgresql+psycopg"}
            or url.username != EXPECTED_DATABASE_USER
            or not url.password
            or url.query
        ):
            raise ValueError
        return url.set(drivername="postgresql").render_as_string(hide_password=False)
    except Exception:
        raise ResetError(
            "MIGRATION_DATABASE_URL must target the local OpenSlate owner database"
        ) from None


def validate_local_database_url(
    url: str,
    target: InstanceTarget | None = None,
    *,
    runner_manifest_authorized: bool = False,
) -> None:
    """Require the one local owner connection admitted for destructive reset."""
    try:
        _validated_database_url(url, target, runner_manifest_authorized=runner_manifest_authorized)
    except InstanceTargetError:
        raise ResetError(
            "MIGRATION_DATABASE_URL does not target the owned OpenSlate instance"
        ) from None


def _normalize_email(value: object) -> str:
    if not isinstance(value, str):
        raise ResetError("The administrator email is invalid")
    normalized = value.strip().casefold()
    if not normalized:
        raise ResetError("The administrator email is required")
    return normalized


def _fetchall(
    connection: Any, statement: str, params: tuple[object, ...] | None = None
) -> list[tuple[object, ...]]:
    with connection.cursor() as cursor:
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
        raise ResetError("The database contains an invalid local identity") from None


def _read_public_table_names(connection: Any) -> None:
    rows = _fetchall(connection, _PUBLIC_TABLES_STATEMENT, ("public",))
    if any(len(row) != 1 or not isinstance(row[0], str) for row in rows):
        raise ResetError("The public application table allowlist has drifted")
    tables = {row[0] for row in rows}
    tables.discard("alembic_version")
    if tables != set(APPLICATION_TABLES):
        raise ResetError("The public application table allowlist has drifted")


def _expected_alembic_head() -> str:
    config = Config()
    migrations = Path(__file__).resolve().parents[1] / "migrations"
    config.set_main_option("script_location", str(migrations))
    heads = ScriptDirectory.from_config(config).get_heads()
    if len(heads) != 1:
        raise ResetError("The repository must have exactly one migration head")
    return heads[0]


def _read_alembic_head(connection: Any) -> str:
    value = _single_value(connection, _ALEMBIC_HEAD_STATEMENT)
    if not isinstance(value, str) or value != _expected_alembic_head():
        raise ResetError("The database migration head is not supported")
    return value


def _read_profile(connection: Any, user_id: UUID) -> ProfileSnapshot:
    rows = _fetchall(connection, _PROFILE_STATEMENT, (user_id,))
    if len(rows) != 1 or len(rows[0]) != 19:
        raise ResetError("The administrator profile is missing or ambiguous")
    row = rows[0]
    return ProfileSnapshot(
        id=_as_uuid(row[0]), created_at=row[1], deleted_at=row[2], is_deleted=row[3],
        updated_at=row[4], performed_by=row[5], email=row[6],
        supabase_user_id=_as_uuid(row[7]) if row[7] is not None else None,
        username=row[8], status=row[9], role_id=_as_uuid(row[10]), display_name=row[11],
        identity_kind=row[12], job_title=row[13],
        sponsor_user_id=_as_uuid(row[14]) if row[14] is not None else None,
        expires_at=row[15], invitation_sent_at=row[16], invitation_accepted_at=row[17],
        tokens_valid_after=row[18],
    )


def _read_provider_subjects(
    connection: Any, preserved_id: UUID, preserved_provider_id: UUID,
) -> tuple[tuple[UUID, UUID | None], ...]:
    rows = _fetchall(connection, _PROVIDER_SUBJECTS_STATEMENT, (preserved_id,))
    subjects: list[tuple[UUID, UUID | None]] = []
    seen_app: set[UUID] = set()
    seen_provider: set[UUID] = {preserved_provider_id}
    for row in rows:
        if len(row) != 2:
            raise ResetError("The provider subject mapping is invalid")
        app_id = _as_uuid(row[0])
        provider_id = _as_uuid(row[1]) if row[1] is not None else None
        if app_id == preserved_id or app_id in seen_app or (
            provider_id is not None and provider_id in seen_provider
        ):
            raise ResetError("The provider subject mapping is ambiguous")
        seen_app.add(app_id)
        if provider_id is not None:
            seen_provider.add(provider_id)
        subjects.append((app_id, provider_id))
    return tuple(sorted(subjects, key=lambda item: str(item[0])))


def _read_workspace(connection: Any) -> WorkspaceSnapshot:
    rows = _fetchall(connection, _WORKSPACE_STATEMENT)
    if len(rows) != 1 or len(rows[0]) != 15:
        raise ResetError("The workspace singleton is missing or ambiguous")
    row = rows[0]
    return WorkspaceSnapshot(
        id=_as_uuid(row[0]), singleton_key=row[1], display_name=row[2], legal_name=row[3],
        description=row[4], contact_email=row[5], contact_phone=row[6], postal_address=row[7],
        logo_file_id=row[8], timezone=row[9], locale=row[10], revision=row[11],
        deleted_at=row[12], is_deleted=row[13], performed_by=row[14],
    )


def _read_roles(connection: Any) -> tuple[RoleSnapshot, ...]:
    roles: list[RoleSnapshot] = []
    for row in _fetchall(connection, _ROLES_STATEMENT):
        if len(row) != 9:
            raise ResetError("The role snapshot is invalid")
        roles.append(
            RoleSnapshot(
                id=_as_uuid(row[0]), created_at=row[1], deleted_at=row[2], is_deleted=row[3],
                updated_at=row[4], performed_by=row[5], role=row[6], permissions=row[7],
                description=row[8],
            )
        )
    if len({role.id for role in roles}) != len(roles):
        raise ResetError("The role snapshot is ambiguous")
    return tuple(sorted(roles, key=lambda role: str(role.id)))


def _read_access_policy_defaults(connection: Any) -> AccessPolicyDefaultsSnapshot:
    rows = _fetchall(connection, _ACCESS_POLICY_DEFAULTS_STATEMENT)
    if len(rows) != 1 or len(rows[0]) != 15:
        raise ResetError("The Access policy defaults singleton is missing or ambiguous")
    row = rows[0]
    snapshot = AccessPolicyDefaultsSnapshot(
        id=_as_uuid(row[0]), singleton_key=row[1], default_role_id=_as_uuid(row[2]),
        invitation_expiry_days=row[3], guest_duration_days=row[4], service_duration_days=row[5],
        default_deny=row[6], require_guest_sponsor=row[7], require_service_owner=row[8],
        revision=row[9], created_at=row[10], deleted_at=row[11], is_deleted=row[12],
        updated_at=row[13], performed_by=row[14],
    )
    if snapshot.id != ACCESS_POLICY_DEFAULTS_ID or snapshot.singleton_key != "workspace":
        raise ResetError("The Access policy defaults singleton is invalid")
    return snapshot


def _read_access_policy_version(connection: Any) -> AccessPolicyVersionSnapshot:
    rows = _fetchall(connection, _ACCESS_POLICY_VERSION_STATEMENT)
    if len(rows) != 1 or len(rows[0]) != 8:
        raise ResetError("The Access policy version singleton is missing or ambiguous")
    row = rows[0]
    snapshot = AccessPolicyVersionSnapshot(
        id=_as_uuid(row[0]), singleton_key=row[1], revision=row[2], created_at=row[3],
        deleted_at=row[4], is_deleted=row[5], updated_at=row[6], performed_by=row[7],
    )
    if snapshot.id != ACCESS_POLICY_VERSION_ID or snapshot.singleton_key != "workspace":
        raise ResetError("The Access policy version singleton is invalid")
    return snapshot


def _read_profile_delete_counts(connection: Any, preserved_id: UUID) -> tuple[int, int]:
    rows = _fetchall(connection, _PROFILE_DELETE_COUNTS_STATEMENT, (preserved_id, preserved_id))
    if len(rows) != 1 or len(rows[0]) != 2:
        raise ResetError("The profile deletion counts are invalid")
    try:
        result = (int(str(rows[0][0])), int(str(rows[0][1])))
    except (TypeError, ValueError):
        raise ResetError("The profile deletion counts are invalid") from None
    if result[0] < 0 or result[1] < 0:
        raise ResetError("The profile deletion counts are invalid")
    return result


def _read_counts(connection: Any) -> Mapping[str, int]:
    counts: dict[str, int] = {}
    for name, statement in _COUNT_STATEMENTS:
        try:
            count = int(str(_single_value(connection, statement)))
        except (TypeError, ValueError):
            raise ResetError("The application row count is invalid") from None
        if count < 0:
            raise ResetError("The application row count is invalid")
        counts[name] = count
    return MappingProxyType(counts)


def _expected_snapshot_payload(snapshot: object, preserved_admin_id: UUID) -> dict[str, object]:
    payload = stable_snapshot_payload(snapshot)
    performed_by = getattr(snapshot, "performed_by", None)
    if performed_by is not None:
        try:
            if _as_uuid(performed_by) != preserved_admin_id:
                payload["performed_by"] = None
        except ResetError:
            payload["performed_by"] = None
    return cast(dict[str, object], payload)


def _impact_digest(plan: ResetPlan) -> str:
    payload = {
        "sample_email": plan.sample_email,
        "counts": dict(plan.counts),
        "profiles_to_delete": plan.profiles_to_delete,
        "inactive_admin_profiles_to_delete": plan.inactive_admin_profiles_to_delete,
        "profile": stable_snapshot_payload(plan.profile_snapshot),
        "preserved_admin_provider_id": str(plan.preserved_admin_provider_id),
        "provider_subjects": [
            [str(app_id), str(provider_id) if provider_id is not None else None]
            for app_id, provider_id in plan.provider_subjects
        ],
        "admin_role": stable_snapshot_payload(plan.admin_role_snapshot),
        "member_role": stable_snapshot_payload(plan.member_role_snapshot),
        "workspace": stable_snapshot_payload(plan.workspace_snapshot),
        "access_policy_defaults": stable_snapshot_payload(
            plan.access_policy_defaults_snapshot
        ),
        "access_policy_version": stable_snapshot_payload(plan.access_policy_version_snapshot),
        "storage_object_keys": list(plan.storage_object_keys),
        "alembic_head": plan.alembic_head,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    ).hexdigest()


def build_reset_plan(
    connection: Any,
    sample_email: str,
    *,
    storage_object_keys: tuple[str, ...] = (),
    read_profile_fn: Callable[[Any, UUID], ProfileSnapshot] = _read_profile,
    read_roles_fn: Callable[[Any], tuple[RoleSnapshot, ...]] = _read_roles,
) -> ResetPlan:
    """Read and validate every local state value required for one safe reset."""
    try:
        email = _normalize_email(sample_email)
        _read_public_table_names(connection)
        alembic_head = _read_alembic_head(connection)
        rows = _fetchall(
            connection,
            "SELECT id FROM public.users WHERE email = %s "
            "AND status = 'active' AND is_deleted = false",
            (email,),
        )
        if len(rows) != 1 or len(rows[0]) != 1:
            raise ResetError("The administrator email must resolve to one active local user")
        admin_id = _as_uuid(rows[0][0])
        profile = read_profile_fn(connection, admin_id)
        if profile.id != admin_id or profile.supabase_user_id is None:
            raise ResetError("The administrator provider identity is not active and preserved")
        provider_subjects = _read_provider_subjects(
            connection, admin_id, profile.supabase_user_id
        )
        if (
            profile.identity_kind != "internal"
            or profile.sponsor_user_id is not None
            or profile.expires_at is not None
        ):
            raise ResetError("The preserved administrator must have a complete internal identity")
        workspace = _read_workspace(connection)
        if workspace.singleton_key is not True or workspace.is_deleted is not False:
            raise ResetError("The workspace singleton is invalid")
        if (
            any(not isinstance(key, str) or not key for key in storage_object_keys)
            or tuple(sorted(storage_object_keys)) != storage_object_keys
            or len(set(storage_object_keys)) != len(storage_object_keys)
        ):
            raise ResetError("The private storage inventory is invalid")
        roles = read_roles_fn(connection)
        access_policy_defaults = _read_access_policy_defaults(connection)
        access_policy_version = _read_access_policy_version(connection)
        admin_roles = [
            role for role in roles if role.role == "admin" and role.is_deleted is False
        ]
        member_roles = [
            role for role in roles if role.role == "member" and role.is_deleted is False
        ]
        if len(admin_roles) != 1 or len(member_roles) != 1 or profile.role_id != admin_roles[0].id:
            raise ResetError("Exactly one active literal admin and member role are required")
        if _fetchall(connection, _EFFECTIVE_ADMIN_PROFILES_STATEMENT, (admin_id,)):
            raise ResetError("Another effective administrator profile exists")
        delete_counts = _read_profile_delete_counts(connection, admin_id)
        if len(provider_subjects) != delete_counts[0]:
            raise ResetError("The provider subject inventory does not match the profiles")
        counts = dict(_read_counts(connection))
        counts.update(
            profiles_to_delete=delete_counts[0],
            inactive_admin_profiles_to_delete=delete_counts[1],
        )
        plan = ResetPlan(
            sample_email=email,
            counts=MappingProxyType(counts),
            profiles_to_delete=delete_counts[0],
            inactive_admin_profiles_to_delete=delete_counts[1],
            impact_digest="",
            preserved_admin_id=admin_id,
            preserved_admin_provider_id=profile.supabase_user_id,
            provider_subjects=provider_subjects,
            preserved_admin_role_id=admin_roles[0].id,
            preserved_member_role_id=member_roles[0].id,
            profile_snapshot=profile,
            admin_role_snapshot=admin_roles[0],
            member_role_snapshot=member_roles[0],
            workspace_snapshot=workspace,
            access_policy_defaults_snapshot=access_policy_defaults,
            access_policy_version_snapshot=access_policy_version,
            storage_object_keys=storage_object_keys,
            alembic_head=alembic_head,
        )
        return replace(plan, impact_digest=_impact_digest(plan))
    except ResetError:
        raise
    except Exception:
        raise ResetError("Unable to validate application data") from None
