"""School hr module definitions."""

from __future__ import annotations

from operations.sample_packs.school.catalog_fields import _choice, _field, _module

MODULES = (
    _module(
        "staff_leave",
        "Staff Leave",
        "hr",
        "LV",
        "From date",
        ("Filed", "Supervisor approved", "HR recorded", "Declined", "Cancelled"),
        110,
        (
            _field("employee", "Employee", "User", "owner", required=True),
            _choice(
                "leave_type",
                "Leave type",
                (
                    "Sick",
                    "Annual leave",
                    "Personal",
                    "Bereavement",
                    "Professional development",
                    "Family leave",
                ),
                required=True,
            ),
            _field("from_date", "From", "Date", "leave_start", required=True),
            _field("to_date", "To", "Date", "leave_end", required=True),
            _field("days", "Days", "Number", "leave_days", required=True, minimum=0.5, maximum=60),
            _field(
                "cover_needed",
                "Cover needed",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _field("cover_teacher", "Cover teacher", "User", "optional_owner"),
            _choice("cover_status", "Cover status", ("Not needed", "Needed", "Arranged")),
        ),
    ),
)
