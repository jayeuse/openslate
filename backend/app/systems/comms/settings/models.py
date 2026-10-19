"""Stored scope/subject shapes; capability and settings evaluation belongs elsewhere."""

from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.mutable import MutableDict
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.access.policy.models import Group
    from app.systems.comms.conversations.models import CommsCategory, CommsConversation


class CommsSettings(BaseModel):
    __tablename__ = "comms_settings"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_settings_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "category_id"], ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_settings_category", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_settings_conversation", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "(scope = 'workspace' AND category_id IS NULL AND conversation_id IS NULL) OR "
            "(scope = 'category' AND category_id IS NOT NULL AND conversation_id IS NULL) OR "
            "(scope = 'channel' AND category_id IS NULL AND conversation_id IS NOT NULL)",
            name="ck_comms_settings_scope",
        ),
        CheckConstraint('jsonb_typeof("values") = \'object\'', name="ck_comms_settings_values"),
        Index(
            "uq_comms_settings_active", "org_id", "scope", "category_id", "conversation_id",
            unique=True, postgresql_nulls_not_distinct=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_comms_settings_category", "org_id", "category_id"),
        Index("ix_comms_settings_conversation", "org_id", "conversation_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    category_id: Mapped[UUID | None] = mapped_column(nullable=True)
    conversation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    values: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB), default=dict, server_default=text("'{}'::jsonb"),
        nullable=False,
    )
    category: Mapped["CommsCategory | None"] = relationship(
        primaryjoin="and_(CommsSettings.org_id == CommsCategory.org_id, "
        "foreign(CommsSettings.category_id) == CommsCategory.id)"
    )
    conversation: Mapped["CommsConversation | None"] = relationship(
        primaryjoin="and_(CommsSettings.org_id == CommsConversation.org_id, "
        "foreign(CommsSettings.conversation_id) == CommsConversation.id)"
    )


class CommsSettingLock(BaseModel):
    """The existence of a live row locks one setting or capability at workspace scope."""

    __tablename__ = "comms_setting_locks"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_setting_locks_org_id_id"),
        CheckConstraint(
            "(namespace = 'setting' AND key IN ("
            "'mode','edit_window_minutes','delete_window_minutes','slow_mode_seconds',"
            "'formatting','link_previews','allowed_reactions','mention_limit','auto_archive_days',"
            "'default_thread_subscription','thread_branches','join_rule','default_member_ids',"
            "'notification_mode','keywords','notify_followed_threads','quiet_hours_start',"
            "'quiet_hours_end','notification_sound','notification_badges','notification_preview',"
            "'desktop_notifications','allowed_file_types','max_file_size_mb','file_previews',"
            "'file_downloads','allowed_record_modules','require_record_link','record_card_fields',"
            "'locked','restricted_person_ids','restriction_until','allow_export',"
            "'pinned_record_id')) "
            "OR (namespace = 'capability' AND key IN ("
            "'react','reply','createThread','attachFiles','linkRecords','mentionChannel','pin',"
            "'manageThreads','deleteOthersMessages','moderate','manageChannel','createChannel'))",
            name="ck_comms_setting_locks_key",
        ),
        Index(
            "uq_comms_setting_locks_active", "org_id", "namespace", "key", unique=True,
            postgresql_where=text("is_deleted = false"),
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    namespace: Mapped[str] = mapped_column(Text, nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)


class CommsCapabilityGrant(BaseModel):
    __tablename__ = "comms_capability_grants"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_capability_grants_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "category_id"], ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_capability_grants_category", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_capability_grants_conversation", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "group_id"], ["groups.org_id", "groups.id"],
            name="fk_comms_capability_grants_group", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "(scope = 'workspace' AND category_id IS NULL AND conversation_id IS NULL) OR "
            "(scope = 'category' AND category_id IS NOT NULL AND conversation_id IS NULL) OR "
            "(scope = 'channel' AND category_id IS NULL AND conversation_id IS NOT NULL)",
            name="ck_comms_capability_grants_scope",
        ),
        CheckConstraint(
            "(subject = 'everyone' AND group_id IS NULL AND capability IN "
            "('react','reply','createThread','attachFiles','linkRecords')) OR "
            "(subject = 'group' AND group_id IS NOT NULL AND granted = true AND ("
            "capability IN ('reply','mentionChannel','pin','manageThreads',"
            "'deleteOthersMessages','moderate') OR "
            "(capability = 'manageChannel' AND scope IN ('category','channel')) OR "
            "(capability = 'createChannel' AND scope IN ('workspace','category'))))",
            name="ck_comms_capability_grants_subject_capability",
        ),
        Index(
            "uq_comms_capability_grants_active", "org_id", "scope", "category_id",
            "conversation_id", "capability", "subject", "group_id", unique=True,
            postgresql_nulls_not_distinct=True, postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_comms_capability_grants_category", "org_id", "category_id"),
        Index("ix_comms_capability_grants_conversation", "org_id", "conversation_id"),
        Index("ix_comms_capability_grants_group", "org_id", "group_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    category_id: Mapped[UUID | None] = mapped_column(nullable=True)
    conversation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    capability: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    group_id: Mapped[UUID | None] = mapped_column(nullable=True)
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    category: Mapped["CommsCategory | None"] = relationship(
        primaryjoin="and_(CommsCapabilityGrant.org_id == CommsCategory.org_id, "
        "foreign(CommsCapabilityGrant.category_id) == CommsCategory.id)"
    )
    conversation: Mapped["CommsConversation | None"] = relationship(
        primaryjoin="and_(CommsCapabilityGrant.org_id == CommsConversation.org_id, "
        "foreign(CommsCapabilityGrant.conversation_id) == CommsConversation.id)"
    )
    group: Mapped["Group | None"] = relationship(
        primaryjoin="and_(CommsCapabilityGrant.org_id == Group.org_id, "
        "foreign(CommsCapabilityGrant.group_id) == Group.id)"
    )


class CommsPersonalPreferences(BaseModel):
    __tablename__ = "comms_personal_preferences"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_personal_preferences_org_id_id"),
        UniqueConstraint("org_id", "user_id", name="uq_comms_personal_preferences_user"),
        CheckConstraint(
            'jsonb_typeof("values") = \'object\'', name="ck_comms_personal_preferences_values"
        ),
        Index("ix_comms_personal_preferences_user", "user_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    values: Mapped[dict[str, Any]] = mapped_column(
        MutableDict.as_mutable(JSONB), default=dict, server_default=text("'{}'::jsonb"),
        nullable=False,
    )


class CommsMemberPreferences(BaseModel):
    """One personal row for a category OR conversation, with no inapplicable values."""

    __tablename__ = "comms_member_preferences"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_member_preferences_org_id_id"),
        UniqueConstraint(
            "org_id", "category_id", "conversation_id", "user_id",
            name="uq_comms_member_preferences_owner_user", postgresql_nulls_not_distinct=True,
        ),
        ForeignKeyConstraint(
            ["org_id", "category_id"], ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_member_preferences_category", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_member_preferences_conversation", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "(category_id IS NOT NULL AND conversation_id IS NULL) OR "
            "(category_id IS NULL AND conversation_id IS NOT NULL)",
            name="ck_comms_member_preferences_owner",
        ),
        CheckConstraint(
            "(category_id IS NOT NULL AND collapsed IS NOT NULL AND notify IS NULL "
            "AND starred IS NULL AND hidden IS NULL AND manual_unread IS NULL) OR "
            "(conversation_id IS NOT NULL AND collapsed IS NULL AND notify IS NOT NULL "
            "AND starred IS NOT NULL AND hidden IS NOT NULL AND manual_unread IS NOT NULL)",
            name="ck_comms_member_preferences_fields",
        ),
        CheckConstraint(
            "notify IS NULL OR notify IN ('all','mentions','mute')",
            name="ck_comms_member_preferences_notify",
        ),
        CheckConstraint(
            "(mute IN ('off','indefinite') AND muted_until IS NULL) OR "
            "(mute = 'until' AND muted_until IS NOT NULL)",
            name="ck_comms_member_preferences_mute",
        ),
        Index("ix_comms_member_preferences_conversation", "org_id", "conversation_id"),
        Index("ix_comms_member_preferences_user", "user_id", "org_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    category_id: Mapped[UUID | None] = mapped_column(nullable=True)
    conversation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    collapsed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    notify: Mapped[str | None] = mapped_column(Text, nullable=True)
    mute: Mapped[str] = mapped_column(Text, default="off", server_default=text("'off'"))
    muted_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    starred: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    hidden: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    manual_unread: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    category: Mapped["CommsCategory | None"] = relationship(
        primaryjoin="and_(CommsMemberPreferences.org_id == CommsCategory.org_id, "
        "foreign(CommsMemberPreferences.category_id) == CommsCategory.id)"
    )
    conversation: Mapped["CommsConversation | None"] = relationship(
        primaryjoin="and_(CommsMemberPreferences.org_id == CommsConversation.org_id, "
        "foreign(CommsMemberPreferences.conversation_id) == CommsConversation.id)"
    )
