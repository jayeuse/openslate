"""Thread metadata, private follows, individual reactions and explicit person mentions."""

from typing import TYPE_CHECKING, ClassVar
from uuid import UUID

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.comms.conversations.models import CommsConversation
    from app.systems.comms.messages.models import CommsMessage


class CommsThread(BaseModel):
    """Counts/times remain on the root message, not duplicated on this metadata row."""

    __tablename__ = "comms_threads"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_threads_org_id_id"),
        UniqueConstraint("org_id", "root_message_id", name="uq_comms_threads_root"),
        ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_threads_conversation", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "conversation_id", "root_message_id"],
            ["comms_messages.org_id", "comms_messages.conversation_id", "comms_messages.id"],
            name="fk_comms_threads_root", ondelete="RESTRICT",
        ),
        Index("ix_comms_threads_conversation", "org_id", "conversation_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    conversation_id: Mapped[UUID] = mapped_column(nullable=False)
    root_message_id: Mapped[UUID] = mapped_column(nullable=False)
    name: Mapped[str] = mapped_column(Text, default="", server_default=text("''"))
    resolved: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    locked: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("false"))
    conversation: Mapped["CommsConversation"] = relationship(
        primaryjoin="and_(CommsThread.org_id == CommsConversation.org_id, "
        "foreign(CommsThread.conversation_id) == CommsConversation.id)"
    )
    root_message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsThread.org_id == CommsMessage.org_id, "
        "CommsThread.conversation_id == CommsMessage.conversation_id, "
        "foreign(CommsThread.root_message_id) == CommsMessage.id)"
    )


class CommsThreadFollow(BaseModel):
    __tablename__ = "comms_thread_follows"
    __audit_enabled__: ClassVar[bool] = False
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_thread_follows_org_id_id"),
        UniqueConstraint(
            "org_id", "root_message_id", "user_id", name="uq_comms_thread_follows_user"
        ),
        ForeignKeyConstraint(
            ["org_id", "root_message_id"], ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_thread_follows_root", ondelete="RESTRICT",
        ),
        Index("ix_comms_thread_follows_user", "user_id", "org_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    root_message_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    root_message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsThreadFollow.org_id == CommsMessage.org_id, "
        "foreign(CommsThreadFollow.root_message_id) == CommsMessage.id)"
    )


class CommsReaction(BaseModel):
    __tablename__ = "comms_reactions"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_reactions_org_id_id"),
        UniqueConstraint(
            "org_id", "message_id", "user_id", "emoji", name="uq_comms_reactions_user"
        ),
        ForeignKeyConstraint(
            ["org_id", "message_id"], ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_reactions_message", ondelete="RESTRICT",
        ),
        CheckConstraint("char_length(emoji) > 0", name="ck_comms_reactions_emoji"),
        Index("ix_comms_reactions_user", "user_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    message_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    emoji: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsReaction.org_id == CommsMessage.org_id, "
        "foreign(CommsReaction.message_id) == CommsMessage.id)"
    )


class CommsMention(BaseModel):
    __tablename__ = "comms_mentions"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_mentions_org_id_id"),
        UniqueConstraint("org_id", "message_id", "user_id", name="uq_comms_mentions_user"),
        ForeignKeyConstraint(
            ["org_id", "message_id"], ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_mentions_message", ondelete="RESTRICT",
        ),
        Index("ix_comms_mentions_user", "user_id", "org_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    message_id: Mapped[UUID] = mapped_column(nullable=False)
    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsMention.org_id == CommsMessage.org_id, "
        "foreign(CommsMention.message_id) == CommsMessage.id)"
    )
