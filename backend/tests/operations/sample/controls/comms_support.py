"""Shared synthetic identities for Comms sample executor tests."""

from operations.sample.controls.actions import plan_controls

ORIGIN = "http://localhost:3000"
PRIMARY = "0190a000-0000-7000-8000-000000000001"
PARTNER = "0190a000-0000-7000-8000-000000000002"
ADMIN = "0190a000-0000-7000-8000-000000000003"
# The installation operator administers the partner organization.
OPERATOR = "0190a000-0000-7000-8000-00000000000c"
CHANNEL = "0190a000-0000-7000-8000-000000000004"
MESSAGE = "0190a000-0000-7000-8000-000000000005"
CATEGORY = "0190a000-0000-7000-8000-000000000006"
DIRECT = "0190a000-0000-7000-8000-000000000007"
GROUP = "0190a000-0000-7000-8000-000000000008"
INVITATION = "0190a000-0000-7000-8000-000000000009"
PRIMARY_DEPARTMENT = "0190a000-0000-7000-8000-00000000000a"
PRIMARY_GROUP = "0190a000-0000-7000-8000-00000000000b"
AT = "2026-10-01T09:00:00+00:00"
EDITED_AT = "2026-10-01T10:00:00+00:00"


def _planned(dataset, operation):
    matches = [
        row
        for row in plan_controls(dataset)
        if row.kind == "comms_controls" and row.values.get("operation") == operation
    ]
    assert len(matches) == 1, "The actual run planner must reach this Comms journey"
    return matches[0]


def _resource(identifier, org):
    return {"id": identifier, "org_id": org, "created_at": AT, "updated_at": AT}
