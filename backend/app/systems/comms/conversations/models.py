"""Categories, conversations and explicit access rows; no access evaluator."""

from datetime import datetime
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel, utc_now

if TYPE_CHECKING:
    from app.systems.access.policy.models import Group
    from app.systems.sandbox.departments.models import Department


class CommsCategory(BaseModel):
    __tablename__ = "comms_categories"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_categories_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "department_id"], ["departments.org_id", "departments.id"],
            name="fk_comms_categories_department", ondelete="RESTRICT",
        ),
        CheckConstraint("btrim(name) <> ''", name="ck_comms_categories_name"),
        CheckConstraint("position >= 0", name="ck_comms_categories_position"),
        Index("ix_comms_categories_order", "org_id", "position", "id"),
        Index("ix_comms_categories_department", "org_id", "department_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    department_id: Mapped[UUID | None] = mapped_column(nullable=True)
    # Only the parent ID is writable through the relationship; org_id stays server-bound.
    department: Mapped["Department | None"] = relationship(
        primaryjoin="and_(CommsCategory.org_id == Department.org_id, "
        "foreign(CommsCategory.department_id) == Department.id)"
    )


class CommsConversation(BaseModel):
    __tablename__ = "comms_conversations"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_conversations_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "category_id"], ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_conversations_category", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "department_id"], ["departments.org_id", "departments.id"],
            name="fk_comms_conversations_department", ondelete="RESTRICT",
        ),
        CheckConstraint("kind IN ('channel','direct','group')", name="ck_comms_conversations_kind"),
        CheckConstraint(
            "scope IN ('organization','department','groups','members')",
            name="ck_comms_conversations_scope",
        ),
        CheckConstraint(
            "(kind = 'channel' AND btrim(name) <> '') OR "
            "(kind IN ('direct','group') AND scope = 'members' AND category_id IS NULL)",
            name="ck_comms_conversations_kind_shape",
        ),
        CheckConstraint(
            "(scope = 'department' AND department_id IS NOT NULL) OR "
            "(scope <> 'department' AND department_id IS NULL)",
            name="ck_comms_conversations_department_shape",
        ),
        CheckConstraint("position >= 0", name="ck_comms_conversations_position"),
        Index("ix_comms_conversations_category_order", "org_id", "category_id", "position", "id"),
        Index("ix_comms_conversations_department", "org_id", "department_id"),
        Index("ix_comms_conversations_creator", "created_by"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    category_id: Mapped[UUID | None] = mapped_column(nullable=True)
    department_id: Mapped[UUID | None] = mapped_column(nullable=True)
    name: Mapped[str] = mapped_column(Text, default="", server_default=text("''"))
    topic: Mapped[str] = mapped_column(Text, default="", server_default=text("''"))
    position: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    category: Mapped["CommsCategory | None"] = relationship(
        primaryjoin="and_(CommsConversation.org_id == CommsCategory.org_id, "
        "foreign(CommsConversation.category_id) == CommsCategory.id)"
    )
    department: Mapped["Department | None"] = relationship(
        primaryjoin="and_(CommsConversation.org_id == Department.org_id, "
        "foreign(CommsConversation.department_id) == Department.id)"
    )


class CommsConversationGroup(BaseModel):
    """Category creation defaults OR explicit conversation access, never live inheritance."""

    __tablename__ = "comms_conversation_groups"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_conversation_groups_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "category_id"], ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_conversation_groups_category", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_conversation_groups_conversation", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "group_id"], ["groups.org_id", "groups.id"],
            name="fk_comms_conversation_groups_group", ondelete="RESTRICT",
        ),
        CheckConstraint(
            "(category_id IS NOT NULL AND conversation_id IS NULL) OR "
            "(category_id IS NULL AND conversation_id IS NOT NULL)",
            name="ck_comms_conversation_groups_owner",
        ),
        CheckConstraint(
            "(subject = 'everyone' AND group_id IS NULL) OR "
            "(subject = 'group' AND group_id IS NOT NULL)",
            name="ck_comms_conversation_groups_subject",
        ),
        CheckConstraint("level IN ('read','post')", name="ck_comms_conversation_groups_level"),
        Index(
            "uq_comms_conversation_groups_active", "org_id", "category_id", "conversation_id",
            "subject", "group_id", unique=True, postgresql_nulls_not_distinct=True,
            postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_comms_conversation_groups_category", "org_id", "category_id"),
        Index("ix_comms_conversation_groups_conversation", "org_id", "conversation_id"),
        Index("ix_comms_conversation_groups_group", "org_id", "group_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    category_id: Mapped[UUID | None] = mapped_column(nullable=True)
    conversation_id: Mapped[UUID | None] = mapped_column(nullable=True)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    group_id: Mapped[UUID | None] = mapped_column(nullable=True)
    level: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped["CommsCategory | None"] = relationship(
        primaryjoin="and_(CommsConversationGroup.org_id == CommsCategory.org_id, "
        "foreign(CommsConversationGroup.category_id) == CommsCategory.id)"
    )
    conversation: Mapped["CommsConversation | None"] = relationship(
        primaryjoin="and_(CommsConversationGroup.org_id == CommsConversation.org_id, "
        "foreign(CommsConversationGroup.conversation_id) == CommsConversation.id)"
    )
    group: Mapped["Group | None"] = relationship(
        primaryjoin="and_(CommsConversationGroup.org_id == Group.org_id, "
        "foreign(CommsConversationGroup.group_id) == Group.id)"
    )


class CommsMember(BaseModel):
    __tablename__ = "comms_members"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_members_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_members_conversation", ondelete="RESTRICT",
        ),
        CheckConstraint("role IN ('member','manager')", name="ck_comms_members_role"),
        Index(
            "uq_comms_members_active", "org_id", "conversation_id", "user_id",
            unique=True, postgresql_where=text("is_deleted = false"),
        ),
        Index("ix_comms_members_conversation", "org_id", "conversation_id"),
        Index("ix_comms_members_user", "user_id", "org_id", "conversation_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(Text, default="member", server_default=text("'member'"))
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utc_now, server_default=func.now(), nullable=False
    )
    conversation: Mapped["CommsConversation"] = relationship(
        primaryjoin="and_(CommsMember.org_id == CommsConversation.org_id, "
        "foreign(CommsMember.conversation_id) == CommsConversation.id)"
    )


class CommsDirectBlock(BaseModel):
    __tablename__ = "comms_direct_blocks"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_direct_blocks_org_id_id"),
        UniqueConstraint(
            "org_id", "user_id", "blocked_user_id", name="uq_comms_direct_blocks_pair"
        ),
        CheckConstraint("user_id <> blocked_user_id", name="ck_comms_direct_blocks_not_self"),
        Index("ix_comms_direct_blocks_user", "user_id"),
        Index("ix_comms_direct_blocks_blocked_user", "blocked_user_id", "org_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    blocked_user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
