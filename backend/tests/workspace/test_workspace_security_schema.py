"""The workspace security partial-update request, without PostgreSQL.

``PATCH /api/workspace/security`` validates its body with ``WorkspaceSecurityUpdate``
before any database work, so each refused body is a row here, with the location the 422
reports (``()`` is the whole body: no field, or ``null`` for a field that is not
nullable). The route tests keep one HTTP 422 case each with their no-write checks:
``auth/test_session_policy_http_integration.py`` (revision unchanged) and
``workspace/test_workspace_security_integration.py`` (policy read unchanged).
"""

from typing import Any

import pytest
from pydantic import ValidationError

from app.systems.manage.workspace.security_schemas import WorkspaceSecurityUpdate

RETENTION_FIELDS = ("session_retention_days", "security_event_retention_days")
RETENTION_TYPES: tuple[Any, ...] = (True, False, "365", 365.0, 0, 3651)


@pytest.mark.parametrize(
    ("patch", "loc"),
    [
        pytest.param({}, (), id="no-field"),
        pytest.param({"mfa_policy": "everyone"}, ("mfa_policy",), id="removed-mfa-policy"),
        pytest.param({"mfa_policy": "required"}, ("mfa_policy",), id="removed-policy-required"),
        pytest.param({"mfa_policy": None}, ("mfa_policy",), id="removed-mfa-policy-null"),
        pytest.param({"unknown": False}, ("unknown",), id="unknown-false"),
        pytest.param({"unknown": True}, ("unknown",), id="unknown-true"),
        pytest.param(
            {"session_timeout_minutes": 20}, ("session_timeout_minutes",), id="timeout-unsupported"
        ),
        pytest.param(
            {"session_timeout_minutes": True}, ("session_timeout_minutes",), id="timeout-bool"
        ),
        pytest.param({"session_timeout_minutes": None}, (), id="timeout-null"),
        pytest.param({"password_min_length": 11}, ("password_min_length",), id="length-11"),
        pytest.param({"password_min_length": 129}, ("password_min_length",), id="length-129"),
        pytest.param({"password_min_length": True}, ("password_min_length",), id="length-bool"),
        pytest.param(
            {"password_require_number": 1}, ("password_require_number",), id="number-rule-int"
        ),
        pytest.param(
            {"password_require_mixed_case": "true"},
            ("password_require_mixed_case",),
            id="mixed-case-string",
        ),
        pytest.param({"password_require_mixed_case": None}, (), id="mixed-case-null"),
        pytest.param({"mfa_require_member": 1}, ("mfa_require_member",), id="mfa-member-int"),
        pytest.param({"mfa_require_admin": None}, (), id="mfa-admin-null"),
        pytest.param({"mfa_grace_days": None}, (), id="grace-null"),
        pytest.param({"mfa_grace_days": "1"}, ("mfa_grace_days",), id="grace-string"),
        pytest.param({"mfa_grace_days": -1}, ("mfa_grace_days",), id="grace-negative"),
        pytest.param({"mfa_grace_days": 31}, ("mfa_grace_days",), id="grace-31"),
        pytest.param(
            {"session_absolute_lifetime_minutes": 0},
            ("session_absolute_lifetime_minutes",),
            id="lifetime-zero",
        ),
        pytest.param(
            {"session_absolute_lifetime_minutes": 43201},
            ("session_absolute_lifetime_minutes",),
            id="lifetime-43201",
        ),
        pytest.param(
            {"session_concurrent_limit": 101}, ("session_concurrent_limit",), id="concurrent-101"
        ),
        pytest.param(
            {"session_concurrent_limit": True}, ("session_concurrent_limit",), id="concurrent-bool"
        ),
        pytest.param(
            {"login_failed_attempt_threshold": 0},
            ("login_failed_attempt_threshold",),
            id="threshold-zero",
        ),
        pytest.param({"login_window_minutes": 1441}, ("login_window_minutes",), id="window-1441"),
        pytest.param(
            {"login_cooldown_minutes": "3"}, ("login_cooldown_minutes",), id="cooldown-string"
        ),
        pytest.param({"ip_allow_list": None}, (), id="allow-list-null"),
        pytest.param({"ip_allow_list": ["private-network"]}, ("ip_allow_list",), id="list-name"),
        pytest.param({"ip_allow_list": ["127.0.0.1/33"]}, ("ip_allow_list",), id="list-prefix"),
        pytest.param({"ip_allow_list": ["127.0.0.1/32"] * 101}, ("ip_allow_list",), id="list-101"),
        *(pytest.param({field: None}, (), id=f"{field}-null") for field in RETENTION_FIELDS),
        *(
            pytest.param({field: value}, (field,), id=f"{field}-{value!r}")
            for field in RETENTION_FIELDS
            for value in RETENTION_TYPES
        ),
    ],
)
def test_security_update_refuses_invalid_partial_input(
    patch: dict[str, Any], loc: tuple[str, ...]
) -> None:
    with pytest.raises(ValidationError) as refused:
        WorkspaceSecurityUpdate.model_validate({"revision": 1, **patch})
    assert [error["loc"][:1] for error in refused.value.errors()] == [loc]


def test_security_update_accepts_a_partial_change_and_the_two_nullable_limits() -> None:
    timeout = WorkspaceSecurityUpdate.model_validate({"revision": 1, "session_timeout_minutes": 30})
    assert timeout.model_fields_set == {"revision", "session_timeout_minutes"}
    cleared = WorkspaceSecurityUpdate.model_validate(
        {"revision": 1, "session_absolute_lifetime_minutes": None, "session_concurrent_limit": None}
    )
    assert cleared.session_absolute_lifetime_minutes is None
    assert cleared.session_concurrent_limit is None
