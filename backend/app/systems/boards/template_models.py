"""Organization-level Board templates containing validated portable v2 bundles."""

from typing import ClassVar

from sqlalchemy import CheckConstraint, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.base_model import BaseModel


class BoardTemplate(BaseModel):
    """Reusable Board structure; routes validate the full portable bundle before storage."""

    __tablename__ = "board_templates"
    __audit_redacted_fields__: ClassVar[frozenset[str]] = frozenset({"bundle"})
    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="ck_board_templates_name_nonempty"),
    )

    name: Mapped[str] = mapped_column(String(80), nullable=False)
    bundle: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
