"""Engineering and Public Works, and City Clerk, Records and Council modules."""

from __future__ import annotations

from operations.sample.packs.local_government.catalog_fields import (
    ACTIONS_REQUIRED,
    BARANGAYS,
    CHANNELS,
    CIVIL_EVENTS,
    COMMITTEES,
    CREWS,
    DOCUMENT_TYPES,
    MEASURE_KINDS,
    OFFICES,
    PRIORITIES,
    SERVICE_TYPES,
    WORK_TYPES,
    _choice,
    _field,
    _flag,
    _module,
    _optional_choice,
)

PUBLIC_WORKS = (
    _module(
        "service_requests",
        "Service Request",
        "public_works",
        "SR",
        "Requested on",
        (
            "New",
            "Acknowledged",
            "Investigating",
            "Action scheduled",
            "In progress",
            "Fixed",
            "No further action",
            "Not responsible",
            "Duplicate",
            "Internal referral",
            "Reopened",
        ),  # fmt: skip
        900,
        (
            _field("sr_no", "Request number", "Text", "reference", required=True),
            _field("requested_on", "Requested on", "Date", "requested_on", required=True),
            _field("requested_at", "Received at", "Date/Time", "requested_at"),
            _choice(
                "service_type",
                "Service type",
                SERVICE_TYPES,
                required=True,
                value_kind="service_type",
            ),  # fmt: skip
            _choice("channel", "Channel", CHANNELS, required=True, value_kind="channel"),
            _choice("barangay", "Barangay", BARANGAYS, required=True, value_kind="barangay"),
            _field("address", "Location", "Text", "street_address", required=True),
            _field(
                "description", "Description", "Long text", "request_description", required=True
            ),  # fmt: skip
            _choice("priority", "Priority", PRIORITIES, value_kind="priority"),
            _field("expected_by", "Expected by", "Date", "expected_by"),
            _field("contact_mobile", "Contact mobile", "Text", "phone"),
        ),
    ),
    _module(
        "work_orders",
        "Work Order",
        "public_works",
        "WO",
        "Scheduled on",
        (
            "Planned",
            "Dispatched",
            "On site",
            "Completed",
            "Verified",
            "On hold for materials",
            "Cancelled",
        ),  # fmt: skip
        300,
        (
            _field("wo_no", "Work order number", "Text", "reference", required=True),
            _field("scheduled_on", "Scheduled on", "Date", "scheduled_on", required=True),
            _choice("work_type", "Work type", WORK_TYPES, required=True, value_kind="work_type"),
            _choice("crew", "Crew", CREWS, value_kind="crew"),
            _field("materials", "Materials used", "Long text", "materials"),
            _field(
                "labor_hours",
                "Labor hours",
                "Number",
                "labor_hours",
                minimum=0,
                maximum=400,
                step=0.5,
            ),  # fmt: skip
            _field("completed_on", "Completed on", "Date", "completed_on"),
            _field("foreman", "Foreman", "User", "foreman", required=True),
            _flag("materials_review", "Materials follow-up"),
        ),
    ),
)

CLERK = (
    _module(
        "communications",
        "Communication",
        "city_clerk",
        "COM",
        "Dated",
        ("Received", "Routed", "In action", "Acted", "Filed", "Returned", "Duplicate"),
        450,
        (
            _field("tracking_no", "Tracking number", "Text", "reference", required=True),
            _field("dated_on", "Dated", "Date", "dated_on", required=True),
            _choice(
                "direction",
                "Direction",
                ("Incoming", "Outgoing", "Internal"),
                required=True,
                value_kind="direction",
            ),  # fmt: skip
            _choice(
                "document_type",
                "Document type",
                DOCUMENT_TYPES,
                required=True,
                value_kind="document_type",
            ),  # fmt: skip
            _field(
                "correspondent", "Sender or addressee", "Text", "correspondent", required=True
            ),  # fmt: skip
            _optional_choice(
                "action_required", "Action required", ACTIONS_REQUIRED, "action_required"
            ),  # fmt: skip
            _optional_choice("routed_to", "Routed to", OFFICES, "routed_to"),
            _choice("priority", "Priority", ("Routine", "Urgent"), value_kind="urgency"),
            _field("due_on", "Due", "Date", "due_on"),
            _field("action_officer", "Action officer", "User", "action_officer"),
        ),
    ),
    _module(
        "legislative_measures",
        "Legislative Measure",
        "city_clerk",
        "SP",
        "Filed on",
        (
            "Filed",
            "First reading and referred",
            "In committee",
            "Committee report",
            "Second reading",
            "Approved on third reading",
            "Transmitted to the Mayor",
            "Signed",
            "Vetoed",
            "Deemed approved",
            "Laid on the table",
            "Withdrawn",
        ),  # fmt: skip
        70,
        (
            _field("measure_no", "Measure number", "Text", "reference", required=True),
            _field("filed_on", "Filed on", "Date", "filed_on", required=True),
            _choice("kind", "Kind", MEASURE_KINDS, required=True, value_kind="measure_kind"),
            _field("authors", "Authors", "Text", "authors", required=True),
            _choice(
                "committee", "Committee", COMMITTEES, required=True, value_kind="committee"
            ),  # fmt: skip
            _field(
                "measure_amount",
                "Amount appropriated ₱",
                "Number",
                "measure_amount",
                minimum=0,
                step=0.01,
            ),  # fmt: skip
            _field("approved_on", "Approved on", "Date", "approved_on"),
            _field("effective_on", "Effective on", "Date", "effective_on"),
            _flag("transmittal_required", "Transmittal needed"),
        ),
    ),
    _module(
        "civil_registry",
        "Civil Registry Entry",
        "city_clerk",
        "LCR",
        "Registered on",
        (
            "Received",
            "Reviewed",
            "Registered",
            "Transmitted to national registry",
            "Posted for 10 days",
            "For correction",
            "Rejected",
        ),  # fmt: skip
        170,
        (
            _field("registry_no", "Registry number", "Text", "reference", required=True),
            _field("registered_on", "Registered on", "Date", "registered_on", required=True),
            _choice("event_type", "Event", CIVIL_EVENTS, required=True, value_kind="civil_event"),
            _field("event_date", "Event date", "Date", "event_date", required=True),
            _choice(
                "timeliness",
                "Timeliness",
                ("Timely", "Delayed"),
                required=True,
                value_kind="timeliness",
            ),  # fmt: skip
            _field(
                "registration_officer", "Registration officer", "User", "registrar", required=True
            ),  # fmt: skip
            _flag("posting_required", "Posting needed"),
        ),
    ),
)
