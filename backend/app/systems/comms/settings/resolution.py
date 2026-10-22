"""Finite settings rules and current ancestry reads; never writes or repairs storage."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal, NotRequired, TypedDict
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join, bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.conversations.models import CommsCategory, CommsConversation
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettingLock, CommsSettings
from app.systems.platform.files.validation import MAX_BYTES, MIME
from app.systems.sandbox.fields.models import Field as RecordField
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


class Scope(TypedDict):
    kind: Literal["workspace", "category", "channel"]
    id: NotRequired[UUID]


def refusal(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def normalize_scope(value: object) -> Scope:
    if not isinstance(value, dict) or value.get("kind") not in ("workspace", "category", "channel"):
        raise refusal("comms_scope_invalid", "Invalid settings scope")
    kind = value["kind"]
    expected = {"kind"} if kind == "workspace" else {"kind", "id"}
    if set(value) != expected:
        raise refusal("comms_scope_invalid", "Invalid settings scope")
    result: Scope = {"kind": kind}
    if kind != "workspace":
        try:
            identity = value["id"]
            result["id"] = identity if isinstance(identity, UUID) else UUID(identity)
        except (ValueError, TypeError, AttributeError) as exc:
            raise refusal("comms_scope_invalid", "Invalid settings scope") from exc
    return result


@dataclass(frozen=True)
class ScopeContext:
    chain: tuple[Scope, ...]
    department_id: UUID | None = None
    conversation: CommsConversation | None = None


def scope_context(db: Session, scope: Scope) -> ScopeContext:
    """Metadata only: does not call capabilities or conversation authorization."""
    db.flush()
    scope = normalize_scope(scope)
    chain: list[Scope] = [{"kind": "workspace"}]
    conversation = None
    category_id = scope.get("id") if scope["kind"] == "category" else None
    department_id = None
    if scope["kind"] == "channel":
        conversation = db.scalar(
            select(CommsConversation)
            .where(
                CommsConversation.id == scope["id"],
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.is_deleted.is_(False),
                CommsConversation.deleted_at.is_(None),
            )
            .execution_options(populate_existing=True)
        )
        if conversation is None:
            raise refusal("comms_not_found", "Conversation not found", 404)
        category_id, department_id = conversation.category_id, conversation.department_id
    if category_id is not None:
        category = db.scalar(
            select(CommsCategory)
            .where(
                CommsCategory.org_id == bound_organization_column(),
                CommsCategory.id == category_id,
                CommsCategory.is_deleted.is_(False),
                CommsCategory.deleted_at.is_(None),
            )
            .execution_options(populate_existing=True)
        )
        if category is None:
            raise refusal("comms_not_found", "Category not found", 404)
        chain.append({"kind": "category", "id": category.id})
        department_id = department_id or category.department_id
    if scope["kind"] == "channel":
        chain.append(scope)
    return ScopeContext(tuple(chain), department_id, conversation)


def scope_clause(
    model: type[CommsSettings] | type[CommsCapabilityGrant],
    scope: Scope,
) -> ColumnElement[bool]:
    return and_(
        model.org_id == bound_organization_column(),
        model.is_deleted.is_(False),
        model.scope == scope["kind"],
        model.category_id == (scope.get("id") if scope["kind"] == "category" else None),
        model.conversation_id == (scope.get("id") if scope["kind"] == "channel" else None),
    )


def locked_keys(db: Session, namespace: Literal["setting", "capability"]) -> set[str]:
    return set(
        db.scalars(
            select(CommsSettingLock.key).where(
                CommsSettingLock.org_id == bound_organization_column(),
                CommsSettingLock.is_deleted.is_(False),
                CommsSettingLock.namespace == namespace,
            )
        )
    )


Watermark = Annotated[int, Field(ge=0, le=9007199254740991)]
ClockTime = Annotated[str, Field(pattern=r"^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$")]


class SettingsValues(BaseModel):
    """Stack-free value schema; references and workspace locks are DB admission."""

    model_config = ConfigDict(extra="forbid", strict=True)
    dm_rule: Literal["everyone", "shared-channel", "none"] = "everyone"
    mode: Literal["normal", "announcements", "thread-first"] = "normal"
    edit_window_minutes: Watermark = 0
    delete_window_minutes: Watermark = 0
    slow_mode_seconds: Watermark = 0
    formatting: bool = True
    link_previews: bool = False
    allowed_reactions: list[str] = Field(
        default_factory=lambda: ["👍", "❤️", "😂", "🔥", "🎉", "👀", "🙏", "✅"],
    )
    mention_limit: Watermark = 0
    auto_archive_days: Watermark = 0
    default_thread_subscription: bool = True
    thread_branches: Literal["all", "followed", "none"] = "all"
    notification_mode: Literal["all", "mentions", "none"] = "all"
    keywords: list[str] = Field(default_factory=list)
    notify_followed_threads: bool = True
    quiet_hours_start: ClockTime = ""
    quiet_hours_end: ClockTime = ""
    notification_sound: bool = True
    notification_badges: bool = True
    notification_preview: bool = True
    desktop_notifications: bool = True
    allowed_file_types: list[str] = Field(default_factory=list)
    max_file_size_mb: Annotated[float, Field(ge=0, le=MAX_BYTES / 1024 / 1024)] = 0
    file_previews: bool = True
    file_downloads: bool = True
    allowed_record_modules: list[str] = Field(default_factory=list)
    require_record_link: bool = False
    record_card_fields: list[str] = Field(default_factory=list)
    locked: bool = False
    restricted_person_ids: list[str] = Field(default_factory=list)
    restriction_until: str | None = None
    allow_export: bool = True
    pinned_record_id: str | None = None

    @field_validator(
        "restricted_person_ids",
        "allowed_record_modules",
        "record_card_fields",
    )
    @classmethod
    def uuid_list(cls, values: list[str]) -> list[str]:
        normalized = [str(UUID(value)) for value in values]
        if len(set(normalized)) != len(normalized):
            raise ValueError("References must be distinct")
        return normalized

    @field_validator("pinned_record_id")
    @classmethod
    def uuid_value(cls, value: str | None) -> str | None:
        return str(UUID(value)) if value is not None else None

    @field_validator("allowed_reactions", "allowed_file_types")
    @classmethod
    def distinct_values(cls, values: list[str]) -> list[str]:
        if any(not value for value in values) or len(set(values)) != len(values):
            raise ValueError("Values must be nonempty and distinct")
        return values

    @field_validator("allowed_file_types")
    @classmethod
    def file_ceiling(cls, values: list[str]) -> list[str]:
        if any(f".{value}" not in MIME for value in values):
            raise ValueError("Unsupported file type")
        return values

    @field_validator("keywords")
    @classmethod
    def keywords_value(cls, values: list[str]) -> list[str]:
        trimmed = [value.strip() for value in values]
        if any(not value for value in trimmed):
            raise ValueError("Keywords cannot be blank")
        return trimmed

    @field_validator("restriction_until")
    @classmethod
    def timestamp_value(cls, value: str | None) -> str | None:
        if value is not None:
            timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if "T" not in value or timestamp.utcoffset() is None:
                raise ValueError("An offset timestamp is required")
        return value


def _paired_hours(values: Mapping[str, Any]) -> bool:
    keys = {"quiet_hours_start", "quiet_hours_end"}
    present = keys & values.keys()
    return not present or (
        present == keys
        and bool(values["quiet_hours_start"])
        == bool(
            values["quiet_hours_end"],
        )
    )


def validated_values(payload: object) -> dict[str, Any]:
    """Strict pure write admission; explicit null is legal only for nullable keys."""
    try:
        values = SettingsValues.model_validate(payload).model_dump(mode="json", exclude_unset=True)
    except ValidationError as exc:
        raise refusal("comms_settings_invalid", "Invalid settings values") from exc
    if not values or not _paired_hours(values):
        raise refusal("comms_settings_invalid", "Set or clear both quiet-hour endpoints")
    return values


def stored_values(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Ignore individual legacy/malformed keys, never mutate the stored mapping."""
    values: dict[str, Any] = {}
    for key, value in payload.items():
        if key == "dm_rule" or key not in SettingsValues.model_fields:
            continue
        try:
            values.update(
                SettingsValues.model_validate({key: value}).model_dump(
                    mode="json",
                    exclude_unset=True,
                )
            )
        except ValidationError:
            continue
    if not _paired_hours(values):
        values.pop("quiet_hours_start", None)
        values.pop("quiet_hours_end", None)
    return values


def resolve_layers(
    layers: Sequence[tuple[Scope, Mapping[str, Any]]],
    locks: set[str],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """The same pure resolver used by current DB reads; no copied ORM world."""
    effective = SettingsValues().model_dump(mode="json", exclude={"dm_rule"})
    sources: dict[str, dict[str, Any]] = {key: {"kind": "default"} for key in effective}
    for scope, values in layers:
        for key, value in stored_values(values).items():
            if scope["kind"] != "workspace" and key in locks:
                continue
            effective[key], sources[key] = value, dict(scope)
    return effective, sources


def _metadata() -> list[dict[str, str]]:
    sections = {
        "overview": "mode pinned_record_id",
        "messaging": "edit_window_minutes delete_window_minutes slow_mode_seconds formatting "
        "link_previews allowed_reactions mention_limit",
        "threads": "auto_archive_days default_thread_subscription thread_branches",
        "notifications": "notification_mode keywords notify_followed_threads quiet_hours_start "
        "quiet_hours_end notification_sound notification_badges "
        "notification_preview desktop_notifications",
        "files": "allowed_file_types max_file_size_mb file_previews file_downloads "
        "allowed_record_modules require_record_link record_card_fields",
        "history": "locked restricted_person_ids restriction_until allow_export",
    }
    common = {
        "mode",
        "edit_window_minutes",
        "delete_window_minutes",
        "notification_mode",
        "allowed_file_types",
        "max_file_size_mb",
    }
    return [
        {"key": key, "section": section, "tier": "common" if key in common else "advanced"}
        for section, keys in sections.items()
        for key in keys.split()
    ]


def channel_effective_settings(
    db: Session, channels: Sequence[CommsConversation]
) -> dict[UUID, dict[str, Any]]:
    """Effective settings of many channels in two statements: stored rows, then locks.

    Same layers as ``resolve_settings``; a deleted category adds nothing (``scope_context``).
    """
    if not channels:
        return {}
    s, category = CommsSettings, CommsCategory
    stored: dict[tuple[str, UUID | None], Mapping[str, Any]] = {}
    for kind, category_id, conversation_id, values in db.execute(
        select(s.scope, s.category_id, s.conversation_id, s.values)
        .outerjoin(
            category,
            and_(
                category.org_id == s.org_id,
                category.id == s.category_id,
                category.is_deleted.is_(False),
                category.deleted_at.is_(None),
            ),
        )
        .where(
            s.org_id == bound_organization_column(),
            s.is_deleted.is_(False),
            or_(
                s.scope == "workspace",
                and_(
                    s.scope == "category",
                    s.category_id.in_({row.category_id for row in channels}),
                    category.id.is_not(None),
                ),
                and_(s.scope == "channel", s.conversation_id.in_([row.id for row in channels])),
            ),
        )
    ).tuples():
        stored[kind, category_id or conversation_id] = values or {}
    locks = locked_keys(db, "setting")
    result: dict[UUID, dict[str, Any]] = {}
    for row in channels:
        layers: list[tuple[Scope, Mapping[str, Any]]] = [
            ({"kind": "workspace"}, stored.get(("workspace", None), {})),
            ({"kind": "channel", "id": row.id}, stored.get(("channel", row.id), {})),
        ]
        if ("category", row.category_id) in stored:
            assert row.category_id is not None
            layers.insert(
                1,
                ({"kind": "category", "id": row.category_id}, stored["category", row.category_id]),
            )
        result[row.id] = resolve_layers(layers, locks)[0]
    return result


def resolve_settings(db: Session, scope: Scope) -> dict[str, Any]:
    context = scope_context(db, scope)
    layers: list[tuple[Scope, Mapping[str, Any]]] = []
    for ancestor in context.chain:
        values = db.scalar(
            select(CommsSettings.values).where(
                scope_clause(CommsSettings, ancestor),
            )
        )
        layers.append((ancestor, values or {}))
    locks = locked_keys(db, "setting")
    effective, sources = resolve_layers(layers, locks)
    response: dict[str, Any] = {
        "org_id": bound_organization(db),
        "scope": context.chain[-1],
        "effective": effective,
        "sources": sources,
        "locked_keys": sorted(locks),
        "overrides": stored_values(layers[-1][1]),
        "metadata": _metadata(),
    }
    if scope["kind"] == "workspace":
        rule = layers[0][1].get("dm_rule", "everyone")
        response["dm_rule"] = rule if rule in ("everyone", "shared-channel", "none") else "everyone"
    return response


def _validate_references(db: Session, values: Mapping[str, Any]) -> None:
    for key in (
        "restricted_person_ids",
        "allowed_record_modules",
        "record_card_fields",
        "pinned_record_id",
    ):
        value = values.get(key)
        if value is None:
            continue
        ids = {UUID(item) for item in (value if isinstance(value, list) else [value])}
        if not ids:
            continue
        if key == "restricted_person_ids":
            statement = (
                select(User.id)
                .join(Membership, bound_membership_join())
                .where(
                    User.id.in_(ids),
                    active_account_clause(),
                )
            )
        else:
            models: dict[str, type[Module] | type[RecordField] | type[Record]] = {
                "allowed_record_modules": Module,
                "record_card_fields": RecordField,
                "pinned_record_id": Record,
            }
            model = models[key]
            statement = select(model.id).where(
                model.id.in_(ids),
                model.org_id == bound_organization_column(),
                model.is_deleted.is_(False),
            )
        if set(db.scalars(statement)) != ids:
            raise refusal("comms_settings_invalid", "Settings reference unavailable data")


def validate_settings_patch(db: Session, scope: Scope, payload: object) -> dict[str, Any]:
    context = scope_context(db, scope)
    values = validated_values(payload)
    if "dm_rule" in values and context.chain[-1]["kind"] != "workspace":
        raise refusal("comms_settings_invalid", "Direct policy requires workspace scope")
    _validate_references(db, values)
    if context.chain[-1]["kind"] != "workspace":
        locks = locked_keys(db, "setting")
        local = (
            db.scalar(
                select(CommsSettings.values).where(
                    scope_clause(
                        CommsSettings,
                        context.chain[-1],
                    )
                )
            )
            or {}
        )
        if any(
            key in locks and (key not in local or local[key] != value)
            for key, value in values.items()
        ):
            raise refusal("comms_settings_locked", "Workspace setting is locked", 403)
    return values
