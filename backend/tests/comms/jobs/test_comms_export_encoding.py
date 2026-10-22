"""Finite encoder boundaries are isolated; native jobs own API/Storage integration."""

import pytest
from pydantic import ValidationError
from uuid6 import uuid7


def test_export_selection_request_has_a_finite_source_bound():
    from app.systems.comms.jobs.schemas import CommsExportCreate

    with pytest.raises(ValidationError):
        CommsExportCreate.model_validate(
            {
                "conversation_ids": [str(uuid7()) for _ in range(101)],
                "format": "csv",
            }
        )


def test_encoded_byte_bound_is_inclusive_and_never_truncates():
    from app.systems.comms.jobs.encoding import ExportTooLarge, bounded_bytes

    content = b"x" * 8_388_608
    assert bounded_bytes(content) == content
    with pytest.raises(ExportTooLarge):
        bounded_bytes(content + b"x")


def test_actual_csv_encoder_rejects_oversize_without_returning_a_prefix():
    from app.systems.comms.jobs.encoding import ExportTooLarge, encode

    row = {"body": "x" * 4000}
    with pytest.raises(ExportTooLarge):
        encode("csv", (row for _ in range(2200)))
