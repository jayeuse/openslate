from uuid import uuid7

from sqlalchemy import Boolean, ForeignKey, inspect

from app.core.base_model import BaseModel
from app.systems.audit.models import AuditLog
from app.systems.audit.schemas import AuditLogResponse
from app.systems.departments.models import Department
from app.systems.departments.schemas import DepartmentCreate, DepartmentResponse
from app.systems.fields.models import Field
from app.systems.fields.schemas import FieldCreate, FieldResponse, FieldUpdate
from app.systems.modules.models import Module
from app.systems.modules.schemas import ModuleCreate, ModuleResponse, ModuleUpdate
from app.systems.records.models import Record
from app.systems.records.schemas import RecordCreate, RecordResponse, RecordUpdate
from app.systems.users.models import Role, User, auth_users
from app.systems.users.schemas import RoleCreate, RoleResponse, RoleUpdate, UserResponse


def test_domain_models_inherit_base_model() -> None:
    assert all(
        issubclass(model, BaseModel) for model in (Role, User, Department, Module, Field, Record)
    )
    assert not issubclass(AuditLog, BaseModel)


def test_relationship_edge_inherits_base_model() -> None:
    from app.systems.relationships.models import RelationshipEdge

    assert issubclass(RelationshipEdge, BaseModel)


def test_domain_columns_and_foreign_keys_match_target_schema() -> None:
    assert set(User.__table__.c) >= {
        User.__table__.c.id,
        User.__table__.c.email,
        User.__table__.c.username,
        User.__table__.c.status,
    }
    assert "password_hash" not in User.__table__.c
    assert User.__table__.c.id.default is None
    assert User.__table__.c.username.type.length == 100
    assert User.__table__.c.email.type.length == 320
    assert User.__table__.c.status.type.length == 20
    assert User.__table__.c.role_id.nullable is False
    invitation_columns = {
        "invitation_sent_at",
        "invitation_accepted_at",
        "tokens_valid_after",
    }
    assert invitation_columns <= set(User.__table__.columns.keys()), (
        "invitation lifecycle columns missing"
    )
    for column_name in invitation_columns:
        assert User.__table__.c[column_name].nullable is True
    assert Department.__table__.c.department_name.type.length == 150
    assert Module.__table__.c.module_name.type.length == 150
    assert Field.__table__.c.type.type.length == 20
    assert Field.__table__.c.position.type.python_type is int
    audit_redacted = Field.__table__.c.audit_redacted
    assert isinstance(audit_redacted.type, Boolean)
    assert audit_redacted.nullable is False
    assert audit_redacted.default is not None
    assert audit_redacted.default.arg is False
    assert audit_redacted.server_default is not None
    assert str(audit_redacted.server_default.arg) == "false"
    assert Record.__table__.c.data.nullable is False

    assert Field.__table__.c.relationship_target_module_id.nullable is True
    assert Field.__table__.c.relationship_multiple_targets.nullable is True
    assert Field.__table__.c.relationship_multiple_sources.nullable is True

    role_fk = next(iter(User.__table__.c.role_id.foreign_keys))
    auth_user_fk = next(iter(User.__table__.c.id.foreign_keys))
    module_fk = next(iter(Record.__table__.c.module_id.foreign_keys))
    assert isinstance(role_fk, ForeignKey)
    assert role_fk.target_fullname == "roles.id"
    assert role_fk.ondelete == "RESTRICT"
    assert isinstance(auth_user_fk, ForeignKey)
    assert auth_user_fk.target_fullname == "auth.users.id"
    assert auth_user_fk.ondelete == "CASCADE"
    assert module_fk.target_fullname == "modules.id"


def test_relationship_edge_columns_reference_fields_and_records() -> None:
    from app.systems.relationships.models import RelationshipEdge

    assert set(RelationshipEdge.__table__.columns.keys()) >= {
        "field_id",
        "source_record_id",
        "target_record_id",
    }
    for column_name in ("field_id", "source_record_id", "target_record_id"):
        column = RelationshipEdge.__table__.c[column_name]
        foreign_key = next(iter(column.foreign_keys))
        assert foreign_key.ondelete == "RESTRICT"


def test_auth_users_metadata_is_an_external_placeholder() -> None:
    assert auth_users.schema == "auth"
    assert auth_users.name == "users"
    assert auth_users.info == {"external": True}
    assert auth_users not in {
        table for table in User.metadata.tables.values() if not table.info.get("external")
    }


def test_audit_log_matches_exact_immutable_shape() -> None:
    assert set(AuditLog.__table__.columns.keys()) == {
        "id",
        "created_at",
        "performed_by",
        "action",
        "entity_type",
        "entity_id",
        "before",
        "after",
        "request_id",
        "request_method",
        "request_path",
        "actor_label",
        "note",
    }
    assert AuditLog.__table__.c.performed_by.nullable
    assert AuditLog.__table__.c.entity_id.nullable
    assert AuditLog.__table__.c.before.nullable
    assert AuditLog.__table__.c.after.nullable
    assert AuditLog.__table__.c.actor_label.nullable
    assert AuditLog.__table__.c.note.nullable


def test_audit_log_response_exposes_migration_actor_metadata() -> None:
    assert AuditLogResponse.model_fields["actor_label"].is_required()
    assert AuditLogResponse.model_fields["note"].is_required()


def test_lifecycle_models_are_immutable_foundation_models() -> None:
    from app.systems.lifecycle.models import (
        LifecycleChallengeStatus,
        LifecycleConfirmationChallenge,
        LifecycleOperation,
        LifecycleRateLimitBucket,
        LifecycleRateLimitFailure,
    )

    assert not issubclass(LifecycleConfirmationChallenge, BaseModel)
    assert not issubclass(LifecycleRateLimitBucket, BaseModel)
    assert LifecycleConfirmationChallenge.__audit_enabled__ is False
    assert LifecycleRateLimitBucket.__audit_enabled__ is False
    assert set(LifecycleConfirmationChallenge.__table__.columns.keys()) >= {
        "id",
        "actor_id",
        "operation",
        "target_type",
        "target_id",
        "impact_digest",
        "token_hash",
        "failed_attempts",
        "status",
        "created_at",
        "updated_at",
        "expires_at",
        "consumed_at",
    }
    assert "account_id" not in LifecycleConfirmationChallenge.__table__.columns
    assert set(LifecycleRateLimitBucket.__table__.columns.keys()) >= {
        "id",
        "actor_id",
        "attempt_count",
        "window_started_at",
        "window_expires_at",
        "blocked_until",
        "created_at",
        "updated_at",
    }
    assert LifecycleConfirmationChallenge.__table__.c.actor_id.nullable is False
    assert LifecycleConfirmationChallenge.__table__.c.token_hash.unique is True
    assert LifecycleConfirmationChallenge.__table__.c.expires_at.nullable is False
    assert LifecycleRateLimitBucket.__table__.c.actor_id.nullable is False
    assert LifecycleRateLimitBucket.__table__.c.actor_id.unique is True
    assert LifecycleRateLimitBucket.__table__.c.blocked_until.nullable is True
    assert not issubclass(LifecycleRateLimitFailure, BaseModel)
    assert LifecycleRateLimitFailure.__audit_enabled__ is False
    assert set(LifecycleRateLimitFailure.__table__.columns.keys()) >= {
        "id",
        "actor_id",
        "occurred_at",
    }
    assert [operation.value for operation in LifecycleOperation] == ["close", "purge"]
    assert [status.value for status in LifecycleChallengeStatus] == [
        "pending",
        "verifying",
        "consumed",
        "expired",
        "invalidated",
        "exhausted",
    ]
    for model in (
        LifecycleConfirmationChallenge,
        LifecycleRateLimitBucket,
        LifecycleRateLimitFailure,
    ):
        actor_foreign_key = next(iter(model.__table__.c.actor_id.foreign_keys))
        assert actor_foreign_key.target_fullname == "users.id"
        assert actor_foreign_key.ondelete == "RESTRICT"


def test_target_schemas_validate_lengths_and_defaults() -> None:
    department_id = uuid7()
    module_id = uuid7()
    department = DepartmentCreate(department_name="Operations")
    module = ModuleCreate(department_id=department_id, module_name="Assets")
    field = FieldCreate(
        module_id=module_id,
        name="Name",
        type="text",
        position=0,
    )
    record = RecordCreate(module_id=module_id)

    assert department.department_name == "Operations"
    assert module.department_id == department_id
    assert field.config == {}
    assert record.data == {}
    assert ModuleUpdate().model_dump(exclude_unset=True) == {}
    assert FieldUpdate().model_dump(exclude_unset=True) == {}
    assert RecordUpdate().model_dump(exclude_unset=True) == {}
    assert DepartmentResponse.model_fields["id"].is_required()
    assert RoleCreate(role="member").permissions == {}
    assert RoleUpdate().model_dump(exclude_unset=True) == {}
    assert RoleResponse.model_fields["permissions"].is_required()
    assert UserResponse.model_fields["role_id"].is_required()
    assert all(
        response.model_fields["performed_by"].is_required()
        for response in (
            RoleResponse,
            UserResponse,
            DepartmentResponse,
            ModuleResponse,
            FieldResponse,
            RecordResponse,
        )
    )


def test_models_have_expected_relationships() -> None:
    assert inspect(Role).relationships["users"].key == "users"
    assert inspect(User).relationships["role"].key == "role"
    assert inspect(Department).relationships["modules"].key == "modules"
    assert inspect(Module).relationships["fields"].key == "fields"
    assert inspect(Module).relationships["records"].key == "records"
