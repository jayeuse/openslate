"""Self-service profile and preferences request bodies, without PostgreSQL.

``PATCH /api/auth/me/profile`` validates ``SelfProfileUpdate`` and
``PATCH /api/users/{id}/preferences`` validates ``UserPreferencesUpdate`` before any
database work, so each refused body is a row here. The route tests keep their HTTP 422
cases with the no-write checks: ``auth/test_self_profile_integration.py`` and
``auth/test_user_preferences_integration.py``.
"""

from typing import Any

import pytest
from pydantic import ValidationError

from app.systems.access.users.schemas import SelfProfileUpdate, UserPreferencesUpdate


@pytest.mark.parametrize(
    ("values", "loc"),
    [
        # Account fields are not self-service: an unapproved key is refused, not ignored.
        pytest.param({"user_id": "actor"}, ("user_id",), id="user-id"),
        pytest.param({"role": "admin"}, ("role",), id="role"),
        pytest.param({"email": "changed@example.test"}, ("email",), id="email"),
        pytest.param({"username": "changed"}, ("username",), id="username"),
        pytest.param({"access": []}, ("access",), id="access"),
        pytest.param({"sponsor_user_id": None}, ("sponsor_user_id",), id="sponsor"),
        pytest.param({"phone": "x" * 33}, ("phone",), id="phone-33"),
        pytest.param({"bio": "x" * 281}, ("bio",), id="bio-281"),
        pytest.param({"display_name": "x" * 201}, ("display_name",), id="display-name-201"),
    ],
)
def test_self_profile_refuses_unapproved_fields_and_bounds(
    values: dict[str, Any], loc: tuple[str, ...]
) -> None:
    with pytest.raises(ValidationError) as refused:
        SelfProfileUpdate.model_validate(values)
    assert [error["loc"] for error in refused.value.errors()] == [loc]


@pytest.mark.parametrize(
    ("invalid", "loc"),
    [
        pytest.param({"theme": None}, ("theme",), id="theme-null"),
        pytest.param({"theme": "sepia"}, ("theme",), id="theme-unknown"),
        pytest.param({"appearance": None}, ("appearance",), id="appearance-null"),
        pytest.param({"appearance": []}, ("appearance",), id="appearance-list"),
        pytest.param({"appearance": {"motion": None}}, ("appearance", "motion"), id="motion-null"),
        pytest.param(
            {"appearance": {"motion": "normal"}}, ("appearance", "motion"), id="motion-unknown"
        ),
        pytest.param(
            {"appearance": {"keyboard_shortcuts": None}},
            ("appearance", "keyboard_shortcuts"),
            id="shortcuts-null",
        ),
        pytest.param(
            {"appearance": {"keyboard_shortcuts": "false"}},
            ("appearance", "keyboard_shortcuts"),
            id="shortcuts-false-string",
        ),
        pytest.param(
            {"appearance": {"keyboard_shortcuts": "true"}},
            ("appearance", "keyboard_shortcuts"),
            id="shortcuts-true-string",
        ),
        pytest.param(
            {"appearance": {"keyboard_shortcuts": 0}},
            ("appearance", "keyboard_shortcuts"),
            id="shortcuts-zero",
        ),
        pytest.param(
            {"appearance": {"keyboard_shortcuts": 1}},
            ("appearance", "keyboard_shortcuts"),
            id="shortcuts-one",
        ),
        pytest.param(
            {"appearance": {"density": "compact"}},
            ("appearance", "density"),
            id="appearance-unknown",
        ),
        pytest.param({"theme": "dark", "role": "admin"}, ("role",), id="role"),
        pytest.param({"text_size": 125}, ("text_size",), id="unknown"),
        pytest.param(
            {"appearance": {"timezone": "Not/AZone"}},
            ("appearance", "timezone"),
            id="timezone-unknown",
        ),
        pytest.param(
            {"appearance": {"timezone": 1}}, ("appearance", "timezone"), id="timezone-number"
        ),
        pytest.param(
            {"appearance": {"date_format": "locale"}},
            ("appearance", "date_format"),
            id="date-format",
        ),
        pytest.param(
            {"appearance": {"time_format": "iso"}}, ("appearance", "time_format"), id="time-format"
        ),
        pytest.param(
            {"appearance": {"week_start": "tuesday"}}, ("appearance", "week_start"), id="week-start"
        ),
        pytest.param(
            {"appearance": {"start_page": "profile"}}, ("appearance", "start_page"), id="start-page"
        ),
        pytest.param(
            {"appearance": {"start_page": None}}, ("appearance", "start_page"), id="start-page-null"
        ),
    ],
)
def test_preferences_refuse_invalid_values(invalid: dict[str, Any], loc: tuple[str, ...]) -> None:
    with pytest.raises(ValidationError) as refused:
        UserPreferencesUpdate.model_validate(invalid)
    assert [error["loc"] for error in refused.value.errors()] == [loc]


def test_profile_and_preferences_accept_the_approved_values() -> None:
    profile = SelfProfileUpdate.model_validate(
        {"display_name": "x" * 200, "phone": "x" * 32, "bio": "x" * 280, "job_title": None}
    )
    assert profile.model_fields_set == {"display_name", "phone", "bio", "job_title"}
    preferences = UserPreferencesUpdate.model_validate(
        {"theme": "dark", "appearance": {"timezone": "America/New_York", "week_start": "sunday"}}
    )
    assert preferences.theme == "dark"
    assert preferences.appearance.timezone == "America/New_York"
    assert preferences.appearance.week_start == "sunday"
