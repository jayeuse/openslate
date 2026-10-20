"""Messages, immutable-revision metadata, counters and read watermarks."""

from datetime import datetime
from typing import TYPE_CHECKING, ClassVar
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.comms.conversations.models import CommsConversation


class CommsMessage(BaseModel):
    """Mutable current content; send_fingerprint retains the original command identity."""

    __tablename__ = "comms_messages"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset(
        {"body", "body_tsv", "send_fingerprint"}
    )
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_messages_org_id_id"),
        UniqueConstraint(
            "org_id", "conversation_id", "id", name="uq_comms_messages_conversation_id"
        ),
        UniqueConstraint("org_id", "conversation_id", "seq", name="uq_comms_messages_sequence"),
        UniqueConstraint("org_id", "author_id", "client_key", name="uq_comms_messages_client_key"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_messages_conversation",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id", "parent_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_messages_parent",
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id", "reply_to_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_messages_reply_to",
            ondelete="RESTRICT",
        ),
        CheckConstraint("seq BETWEEN 1 AND 9007199254740991", name="ck_comms_messages_sequence"),
        CheckConstraint(
            "mutation_generation BETWEEN 0 AND 9007199254740991",
            name="ck_comms_messages_mutation_generation",
        ),
        CheckConstraint("char_length(body) <= 4000", name="ck_comms_messages_body_length"),
        CheckConstraint(
            "send_fingerprint ~ '^[0-9a-f]{64}$'", name="ck_comms_messages_send_fingerprint"
        ),
        CheckConstraint(
            "reply_count BETWEEN 0 AND 9007199254740991", name="ck_comms_messages_reply_count"
        ),
        CheckConstraint(
            "parent_id IS NULL OR parent_id <> id", name="ck_comms_messages_parent_self"
        ),
        CheckConstraint(
            "reply_to_id IS NULL OR reply_to_id <> id", name="ck_comms_messages_reply_to_self"
        ),
        CheckConstraint(
            "parent_id IS NOT NULL OR also_send_to_channel = false",
            name="ck_comms_messages_channel_reply",
        ),
        Index(
            "ix_comms_messages_live_roots",
            "org_id",
            "conversation_id",
            "seq",
            postgresql_where=text("parent_id IS NULL AND is_deleted = false"),
        ),
        Index("ix_comms_messages_replies", "org_id", "parent_id", "seq"),
        Index("ix_comms_messages_quote", "org_id", "reply_to_id"),
        Index("ix_comms_messages_body_search", "body_tsv", postgresql_using="gin"),
        Index("ix_comms_messages_author", "author_id", "created_at"),
        Index("ix_comms_messages_deleted_by", "deleted_by"),
        Index("ix_comms_messages_pinned_by", "pinned_by"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mutation_generation: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default=text("0"), nullable=False,
    )
    author_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    client_key: Mapped[UUID] = mapped_column(nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    body_tsv: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple'::regconfig, body)", persisted=True), nullable=False
    )
    # Mutation protection is installed deliberately in the reviewed generated migration.
    send_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    parent_id: Mapped[UUID | None] = mapped_column(nullable=True)
    reply_to_id: Mapped[UUID | None] = mapped_column(nullable=True)
    also_send_to_channel: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    reply_count: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    last_reply_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    mentions_channel: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    mentions_here: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false"), nullable=False
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pinned_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    conversation: Mapped["CommsConversation"] = relationship(
        primaryjoin="and_(CommsMessage.org_id == CommsConversation.org_id, "
        "foreign(CommsMessage.conversation_id) == CommsConversation.id)"
    )
    parent: Mapped["CommsMessage | None"] = relationship(
        primaryjoin="and_(CommsMessage.org_id == remote(CommsMessage.org_id), "
        "CommsMessage.conversation_id == remote(CommsMessage.conversation_id), "
        "foreign(CommsMessage.parent_id) == remote(CommsMessage.id))"
    )
    reply_to: Mapped["CommsMessage | None"] = relationship(
        primaryjoin="and_(CommsMessage.org_id == remote(CommsMessage.org_id), "
        "CommsMessage.conversation_id == remote(CommsMessage.conversation_id), "
        "foreign(CommsMessage.reply_to_id) == remote(CommsMessage.id))"
    )


class CommsMessageRevision(BaseModel):
    """Retained content; the reviewed migration must forbid UPDATE and check parent org."""

    __tablename__ = "comms_message_revisions"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"body"})
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_message_revisions_org_id_id"),
        ForeignKeyConstraint(
            ["org_id", "message_id"],
            ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_message_revisions_message",
            ondelete="RESTRICT",
        ),
        CheckConstraint("char_length(body) <= 4000", name="ck_comms_message_revisions_body_length"),
        Index("ix_comms_message_revisions_history", "org_id", "message_id", "created_at", "id"),
        Index("ix_comms_message_revisions_author", "author_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    message_id: Mapped[UUID] = mapped_column(nullable=False)
    author_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsMessageRevision.org_id == CommsMessage.org_id, "
        "foreign(CommsMessageRevision.message_id) == CommsMessage.id)"
    )


class CommsConversationCounter(BaseModel):
    """Transactionally locked allocator state, not a PostgreSQL sequence."""

    __tablename__ = "comms_conversation_counters"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_conversation_counters_org_id_id"),
        UniqueConstraint(
            "org_id", "conversation_id", name="uq_comms_conversation_counters_conversation"
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_conversation_counters_conversation",
            ondelete="RESTRICT",
        ),
        CheckConstraint(
            "last_seq BETWEEN 0 AND 9007199254740991",
            name="ck_comms_conversation_counters_sequence",
        ),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    last_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    conversation: Mapped["CommsConversation"] = relationship(
        primaryjoin="and_(CommsConversationCounter.org_id == CommsConversation.org_id, "
        "foreign(CommsConversationCounter.conversation_id) == CommsConversation.id)"
    )


class CommsReadState(BaseModel):
    __tablename__ = "comms_read_states"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_read_states_org_id_id"),
        UniqueConstraint(
            "org_id", "conversation_id", "user_id", name="uq_comms_read_states_conversation_user"
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_read_states_conversation",
            ondelete="RESTRICT",
        ),
        CheckConstraint(
            "last_read_seq BETWEEN 0 AND 9007199254740991", name="ck_comms_read_states_sequence"
        ),
        Index("ix_comms_read_states_user", "user_id", "org_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    last_read_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text("0"))
    conversation: Mapped["CommsConversation"] = relationship(
        primaryjoin="and_(CommsReadState.org_id == CommsConversation.org_id, "
        "foreign(CommsReadState.conversation_id) == CommsConversation.id)"
    )
