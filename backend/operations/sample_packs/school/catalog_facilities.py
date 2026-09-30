"""School facilities module definitions."""

from __future__ import annotations

from operations.sample_packs.school.catalog_fields import _choice, _field, _module

MODULES = (
    _module(
        "rooms",
        "Room",
        "facilities",
        "ROOM",
        "",
        ("Available", "Under repair", "Closed"),
        70,
        (
            _field("room_code", "Room code", "Text", "room_code", required=True),
            _choice(
                "building",
                "Building",
                ("Lower School", "Middle School", "Upper School", "Arts Block", "Sports Centre"),
                required=True,
            ),
            _choice(
                "room_type",
                "Room type",
                (
                    "Classroom",
                    "Science laboratory",
                    "Computing room",
                    "Gym",
                    "Auditorium",
                    "Library",
                    "Music room",
                    "Clinic",
                    "Office",
                ),
                required=True,
            ),
            _field("capacity", "Capacity", "Integer", "capacity", minimum=1, maximum=300, step=1),
            _field("custodian", "Custodian", "User", "owner"),
        ),
    ),
    _module(
        "maintenance_requests",
        "Maintenance Request",
        "facilities",
        "WO",
        "Due date",
        (
            "New",
            "Assigned",
            "In progress",
            "Completed",
            "Closed",
            "On hold",
            "Rejected",
            "Duplicate",
        ),
        130,
        (
            _field("work_order_no", "Work order number", "Text", "reference", required=True),
            _choice(
                "category",
                "Category",
                (
                    "Electrical",
                    "Plumbing",
                    "Heating and ventilation",
                    "Carpentry",
                    "IT and AV",
                    "Cleaning",
                    "Safety hazard",
                    "Grounds",
                    "Preventive",
                ),
                required=True,
            ),
            _choice("priority", "Priority", ("Emergency", "High", "Normal", "Low"), required=True),
            _field("description", "Description", "Long text", "maintenance_note", required=True),
            _field("requested_by", "Requested by", "User", "owner", required=True),
            _field("assigned_to", "Assigned technician", "User", "optional_owner"),
            _field(
                "review_required",
                "Scheduled review needed",
                "Checkbox",
                "boolean",
                default=False,
                has_default=True,
            ),
            _field("completed_on", "Completed on", "Date", "completed_date"),
        ),
    ),
)
