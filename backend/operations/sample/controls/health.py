"""System health reads of the sample run: the 30-day periods and both support files.

Every signed-in person reads the periods, so a plain member checks them. The pack
administrator downloads the organization's support file and the installation operator
the installation's (installation controls only). Each file must arrive whole, typed and
with its summary first; the organization file must hold nothing installation-wide.
"""

import json
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, ValidationError

from app.systems.manage.health.diagnostics import InstallationDiagnostics, OrganizationDiagnostics
from app.systems.manage.health.schemas import HealthPeriodListResponse
from operations.sample.controls.planned_actors import OPERATOR
from operations.sample.packs.phase_types import PhaseJsonValue
from operations.sample.phases.actions import SamplePhaseActionError

PERIODS = "/api/system/health-periods"
ORGANIZATION_FILE = "/api/system/diagnostics/organization"
INSTALLATION_FILE = "/api/system/diagnostics/installation"
HEALTH_ROUTES = frozenset(
    {("GET", PERIODS), ("GET", ORGANIZATION_FILE), ("GET", INSTALLATION_FILE)}
)
HEALTH_OPERATIONS = frozenset(
    {
        "review_health_periods",
        "download_organization_support_file",
        "download_installation_support_file",
    }
)
# The installation file is installation-wide; one pack per installation reads it.
INSTALLATION_OPERATIONS = frozenset({"download_installation_support_file"})
# Each file keeps its contract's key order, summary first.
_ORGANIZATION_KEYS = list(OrganizationDiagnostics.model_fields)
_INSTALLATION_KEYS = list(InstallationDiagnostics.model_fields)

Read = Callable[[str], dict[str, Any]]


def health_specs(member: str) -> tuple[tuple[str, str, int, dict[str, PhaseJsonValue]], ...]:
    return (
        ("review_health_periods", member, 200, {"read_checks": 1, "health_periods_shape": True}),
        (
            "download_organization_support_file",
            "admin",
            200,
            {"read_checks": 1, "organization_file_scoped": True},
        ),
        (
            "download_installation_support_file",
            OPERATOR,
            200,
            {"read_checks": 1, "installation_file_shape": True},
        ),
    )


def _typed(model: type[BaseModel], body: dict[str, Any], message: str, step: str) -> BaseModel:
    try:
        return model.model_validate_json(json.dumps(body), strict=True)
    except ValidationError:
        raise SamplePhaseActionError(message, step=step) from None


def execute_health_control(operation: str, read: Read, step: str) -> dict[str, object]:
    if operation == "review_health_periods":
        page = _typed(
            HealthPeriodListResponse, read(PERIODS), "System health periods response is invalid",
            step,
        )
        assert isinstance(page, HealthPeriodListResponse)
        meta = page.pagination
        if (
            (meta.limit, meta.offset) != (5, 0)
            or meta.count != len(page.items)
            or meta.has_more != (meta.count < meta.total)
        ):
            raise SamplePhaseActionError(
                "System health periods differ from the first page", step=step
            )
        return {"health_periods_shape": True}
    if operation == "download_organization_support_file":
        body = read(ORGANIZATION_FILE)
        _typed(OrganizationDiagnostics, body, "Organization support file is invalid", step)
        if list(body) != _ORGANIZATION_KEYS or body["summary"]["kind"] != "organization":
            raise SamplePhaseActionError(
                "Organization support file holds more than its organization", step=step
            )
        return {"organization_file_scoped": True}
    if operation == "download_installation_support_file":
        body = read(INSTALLATION_FILE)
        _typed(InstallationDiagnostics, body, "Installation support file is invalid", step)
        if list(body) != _INSTALLATION_KEYS or body["summary"]["kind"] != "installation":
            raise SamplePhaseActionError(
                "Installation support file differs from its contract", step=step
            )
        return {"installation_file_shape": True}
    raise SamplePhaseActionError("Unknown system health control", step=step)
