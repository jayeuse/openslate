import re

from scripts.seed_sample_data_specs import FIELD_SPECS, RECORD_SPECS

CANONICAL_DECIMAL = re.compile(r"-?(0|[1-9][0-9]*)(\.[0-9]+)?$")


def _assert_canonical_decimal(value: object) -> None:
    assert isinstance(value, str)
    assert CANONICAL_DECIMAL.fullmatch(value)
    assert value != "-0"
    if "." in value:
        integer_part, fractional_part = value.split(".", 1)
        assert not fractional_part.endswith("0")
    else:
        integer_part = value
    assert len(integer_part.removeprefix("-")) <= 38
    assert "." not in value or len(fractional_part) <= 18


def test_sample_seed_uses_canonical_strings_for_every_decimal_producer() -> None:
    field_types = {spec[0]: spec[3] for spec in FIELD_SPECS}

    for _logical_id, _module_id, _name, field_type, _required, _position, config in FIELD_SPECS:
        if field_type == "decimal":
            for bound_name in ("minimum", "maximum"):
                if bound_name in config:
                    _assert_canonical_decimal(config[bound_name])

    for _logical_id, _module_id, data in RECORD_SPECS:
        for field_id, value in data.items():
            if field_types.get(field_id) == "decimal":
                _assert_canonical_decimal(value)
