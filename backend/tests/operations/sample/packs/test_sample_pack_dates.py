"""A birth date is master data and must pass ordinary API field validation."""

from datetime import date
from uuid import uuid4

from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.fields.validation import validate_field_value
from operations.sample.blueprint import _field_config
from operations.sample.packs.types import FieldSpec
from tests.operations.sample.packs.test_sample_packs import _TINY_PACK


def test_birth_dates_are_not_limited_to_the_operational_run_window():
    spec = FieldSpec("birth_date", "Birth date", "Date", "birth_date", required=True)
    config = _field_config(spec, 17, date(2026, 9, 30), "students", _TINY_PACK)
    field = Field(id=uuid4(), module_id=uuid4(), name="Birth date", type="date", config=config)
    assert validate_field_value(field, "2008-02-21") == "2008-02-21"
