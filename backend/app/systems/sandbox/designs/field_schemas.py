"""Strict field and option schemas shared by Sandbox documents."""

from __future__ import annotations

import re
from typing import Annotated, Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.systems.sandbox.designs.date_values import date_in_range, valid_date, valid_datetime
from app.systems.sandbox.numeric import numeric_matches_step

ID = Annotated[str, Field(min_length=1, max_length=1_000)]
Name = Annotated[str, Field(min_length=1, max_length=80)]
VersionLabel = Annotated[str, Field(min_length=1, max_length=80)]
Text = Annotated[str, Field(max_length=1_000)]
FiniteNumber = Annotated[float, Field(ge=-100_000, le=100_000, allow_inf_nan=False)]
TypedValue = str | int | Annotated[float, Field(allow_inf_nan=False)] | bool | None


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class TextFieldConfig(StrictModel):
    kind: Literal["text", "long-text", "email", "url"]
    default_value: Text = Field(default="", alias="defaultValue")
    max_length: int | None = Field(default=None, ge=1, le=1_000, alias="maxLength")


class NumberFieldConfig(StrictModel):
    kind: Literal["number", "integer"]
    default_value: float | None = Field(default=None, allow_inf_nan=False, alias="defaultValue")
    minimum: float | None = Field(default=None, allow_inf_nan=False, alias="min")
    maximum: float | None = Field(default=None, allow_inf_nan=False, alias="max")
    step: float | None = Field(default=None, gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _valid_range(self) -> NumberFieldConfig:
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError("min cannot exceed max")
        if self.kind == "integer" and any(
            value is not None and not float(value).is_integer()
            for value in (self.default_value, self.minimum, self.maximum, self.step)
        ):
            raise ValueError("integer field constraints must be whole numbers")
        return self


class DateFieldConfig(StrictModel):
    kind: Literal["date", "datetime"]
    default_value: str | None = Field(default=None, max_length=64, alias="defaultValue")
    earliest: str | None = Field(default=None, max_length=64)
    latest: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _valid_range(self) -> DateFieldConfig:
        valid = valid_date if self.kind == "date" else valid_datetime
        for value in (self.default_value, self.earliest, self.latest):
            if value is not None and not valid(value):
                raise ValueError(f"{self.kind} values must use valid ISO syntax")
        datetime_values = self.kind == "datetime"
        if (
            self.earliest is not None
            and self.latest is not None
            and not date_in_range(
                self.earliest, None, self.latest, datetime_values=datetime_values
            )
        ):
            raise ValueError("earliest cannot exceed latest")
        if self.default_value is not None and not date_in_range(
            self.default_value,
            self.earliest,
            self.latest,
            datetime_values=datetime_values,
        ):
            raise ValueError("defaultValue must be within the earliest and latest limits")
        return self


class CheckboxFieldConfig(StrictModel):
    kind: Literal["checkbox"]
    default_value: bool = Field(default=False, alias="defaultValue")


class SelectOption(StrictModel):
    id: str = Field(min_length=36, max_length=36)
    label: str = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def _valid_option(self) -> SelectOption:
        try:
            if str(UUID(self.id)) != self.id:
                raise ValueError
        except ValueError as error:
            raise ValueError("select option id must be a canonical UUID") from error
        if not self.label.strip():
            raise ValueError("select option label must not be blank")
        return self


class SelectFieldConfig(StrictModel):
    kind: Literal["select"]
    default_value: str | None = Field(default=None, max_length=36, alias="defaultValue")
    options: list[SelectOption] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def _default_is_option(self) -> SelectFieldConfig:
        option_ids = [option.id for option in self.options]
        labels = [option.label for option in self.options]
        if self.default_value is not None and self.default_value not in option_ids:
            raise ValueError("select defaultValue must be an option")
        if len(option_ids) != len(set(option_ids)) or len(labels) != len(set(labels)):
            raise ValueError("select option IDs and labels must be unique")
        return self


class UserFieldConfig(StrictModel):
    kind: Literal["user"]


FieldConfig = Annotated[
    TextFieldConfig
    | NumberFieldConfig
    | DateFieldConfig
    | CheckboxFieldConfig
    | SelectFieldConfig
    | UserFieldConfig,
    Field(discriminator="kind"),
]


def _field_default_is_valid(config: FieldConfig) -> bool:
    value = getattr(config, "default_value", None)
    if value is None:
        return True
    if isinstance(config, TextFieldConfig):
        if not isinstance(value, str) or (
            config.max_length is not None and len(value) > config.max_length
        ):
            return False
        if config.kind == "email":
            return not value or re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value) is not None
        if config.kind == "url":
            parsed = urlparse(value)
            return not value or (parsed.scheme in {"http", "https"} and bool(parsed.netloc))
        return True
    if isinstance(config, NumberFieldConfig):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        numeric_value = float(value)
        if config.minimum is not None and numeric_value < config.minimum:
            return False
        if config.maximum is not None and numeric_value > config.maximum:
            return False
        step = config.step if config.step is not None else (1 if config.kind == "integer" else None)
        if step is None:
            return True
        return numeric_matches_step(numeric_value, config.minimum or 0, step)
    if isinstance(config, DateFieldConfig):
        return isinstance(value, str) and date_in_range(
            value,
            config.earliest,
            config.latest,
            datetime_values=config.kind == "datetime",
        )
    if isinstance(config, CheckboxFieldConfig):
        return isinstance(value, bool)
    return (
        isinstance(config, SelectFieldConfig)
        and isinstance(value, str)
        and any(option.id == value for option in config.options)
    )


class DesignField(StrictModel):
    id: ID
    name: Name
    type: Literal[
        "Text",
        "Long text",
        "Number",
        "Integer",
        "Date",
        "Date/Time",
        "Checkbox",
        "Select",
        "Email",
        "URL",
        "User",
    ]
    required: bool = False
    closed: bool = False
    description: Text | None = None
    config: FieldConfig

    @model_validator(mode="after")
    def _matching_config(self) -> DesignField:
        expected_kind = {
            "Text": "text",
            "Long text": "long-text",
            "Number": "number",
            "Integer": "integer",
            "Date": "date",
            "Date/Time": "datetime",
            "Checkbox": "checkbox",
            "Select": "select",
            "Email": "email",
            "URL": "url",
            "User": "user",
        }[self.type]
        if expected_kind != self.config.kind:
            raise ValueError("field type must match config kind")
        if not _field_default_is_valid(self.config):
            raise ValueError("field config defaultValue does not match its field")
        return self


