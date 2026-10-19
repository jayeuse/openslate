"""Message-owned file and record references, without upload or authorization behavior."""

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import ForeignKey, ForeignKeyConstraint, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.base_model import BaseModel

if TYPE_CHECKING:
    from app.systems.comms.messages.models import CommsMessage
    from app.systems.platform.files.models import File
    from app.systems.sandbox.modules.models import Module
    from app.systems.sandbox.records.models import Record


class CommsMessageAttachment(BaseModel):
    """Lifetime file identity; owner UPDATE protection belongs in the reviewed migration."""

    __tablename__ = "comms_message_attachments"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_message_attachments_org_id_id"),
        UniqueConstraint("org_id", "file_id", name="uq_comms_message_attachments_file"),
        ForeignKeyConstraint(
            ["org_id", "message_id"], ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_message_attachments_message", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "file_id"], ["files.org_id", "files.id"],
            name="fk_comms_message_attachments_file", ondelete="RESTRICT",
        ),
        Index("ix_comms_message_attachments_message", "org_id", "message_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    message_id: Mapped[UUID] = mapped_column(nullable=False)
    file_id: Mapped[UUID] = mapped_column(nullable=False)
    message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsMessageAttachment.org_id == CommsMessage.org_id, "
        "foreign(CommsMessageAttachment.message_id) == CommsMessage.id)"
    )
    file: Mapped["File"] = relationship(
        primaryjoin="and_(CommsMessageAttachment.org_id == File.org_id, "
        "foreign(CommsMessageAttachment.file_id) == File.id)"
    )


class CommsMessageRecordLink(BaseModel):
    """Reference IDs only; current record visibility and module matching are admission checks."""

    __tablename__ = "comms_message_record_links"
    __table_args__ = (
        UniqueConstraint("org_id", "id", name="uq_comms_message_record_links_org_id_id"),
        UniqueConstraint(
            "org_id", "message_id", "record_id", name="uq_comms_message_record_links_record"
        ),
        ForeignKeyConstraint(
            ["org_id", "message_id"], ["comms_messages.org_id", "comms_messages.id"],
            name="fk_comms_message_record_links_message", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "record_id"], ["records.org_id", "records.id"],
            name="fk_comms_message_record_links_record", ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["org_id", "module_id"], ["modules.org_id", "modules.id"],
            name="fk_comms_message_record_links_module", ondelete="RESTRICT",
        ),
        Index("ix_comms_message_record_links_record", "org_id", "record_id"),
        Index("ix_comms_message_record_links_module", "org_id", "module_id"),
    )

    org_id: Mapped[UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False
    )
    message_id: Mapped[UUID] = mapped_column(nullable=False)
    record_id: Mapped[UUID] = mapped_column(nullable=False)
    module_id: Mapped[UUID] = mapped_column(nullable=False)
    message: Mapped["CommsMessage"] = relationship(
        primaryjoin="and_(CommsMessageRecordLink.org_id == CommsMessage.org_id, "
        "foreign(CommsMessageRecordLink.message_id) == CommsMessage.id)"
    )
    record: Mapped["Record"] = relationship(
        primaryjoin="and_(CommsMessageRecordLink.org_id == Record.org_id, "
        "foreign(CommsMessageRecordLink.record_id) == Record.id)"
    )
    module: Mapped["Module"] = relationship(
        primaryjoin="and_(CommsMessageRecordLink.org_id == Module.org_id, "
        "foreign(CommsMessageRecordLink.module_id) == Module.id)"
    )
