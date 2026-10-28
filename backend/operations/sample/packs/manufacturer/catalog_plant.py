"""Warehouse and Logistics, Production, and Quality and Food Safety modules (research §4).

pH, Brix and viscosity are fields on the Batch Record, not records (plan scope decision).
Best-by dates lie past the Sandbox date window, so they are printed text.
"""

from __future__ import annotations

from operations.sample.packs.manufacturer.catalog_fields import (
    CHECK_TYPES,
    DEFECT_TYPES,
    DISPOSITIONS,
    KETTLES,
    LOSS_CATEGORIES,
    NCR_SOURCES,
    REASON_CODES,
    ROOT_CAUSE_METHODS,
    SEVERITIES,
    SHIFTS,
    WORK_CENTER_TYPES,
    _check,
    _choice,
    _count,
    _field,
    _flag,
    _module,
    _money,
    _optional_choice,
)

WAREHOUSE = (
    _module(
        "material_lots",
        "Material Lot",
        "warehouse",
        "R",
        "Received date",
        ("Quarantine", "Released", "Rejected", "On hold", "Consumed", "Expired"),
        240,
        (
            _field("receipt_no", "Receipt no", "Text", "reference", required=True),
            _field("received_date", "Received date", "Date", "received_date", required=True),
            _field("supplier_lot", "Supplier lot", "Text", "supplier_lot", required=True),
            _field("qty_received", "Qty received", "Number", "qty_received", required=True,
                   minimum=0),  # fmt: skip
            _field("best_before", "Best before", "Text", "best_before"),
            _check("coa_received", "COA received"),
            _check("seal_intact", "Trailer seal intact"),
            _field("location", "Location", "Text", "location"),
            _field("received_by", "Received by", "User", "receiver"),
            _field("inspected_by", "Inspected by", "User", "inspector"),
            _flag("ncr_required", "NCR required"),
        ),
    ),
    _module(
        "shipments",
        "Shipment",
        "warehouse",
        "BOL",
        "Ship date",
        ("Planned", "Picking", "Loaded", "Shipped", "Delivered", "Refused"),
        310,
        (
            _field("bol_number", "BOL number", "Text", "reference", required=True),
            _field("ship_date", "Ship date", "Date", "ship_date", required=True),
            _field("carrier", "Carrier", "Text", "carrier"),
            _count("pallets", "Pallets", "pallets", maximum=30),
            _check("trailer_ok", "Trailer condition OK"),
            _field("seal_number", "Seal number", "Text", "seal_number"),
            _money("freight_cost", "Freight cost $", "freight_cost"),
            _field("shipped_by", "Shipped by", "User", "shipper"),
        ),
    ),
)

MANUFACTURING = (
    _module(
        "work_centers",
        "Work Center",
        "manufacturing",
        "WC",
        "Last changeover",
        ("Running", "Down", "Sanitation", "Idle"),
        8,
        (
            _field("wc_code", "Code", "Text", "reference", required=True),
            _choice("wc_type", "Type", WORK_CENTER_TYPES, value_kind="wc_type"),
            _field("rated_speed", "Rated speed units/min", "Number", "rated_speed", minimum=0),
            _field("shift_pattern", "Shift pattern", "Text", "shift_pattern"),
        ),
    ),
    _module(
        "batch_records",
        "Batch Record",
        "manufacturing",
        "B",
        "Batch date",
        ("Weighing", "Cooking", "Awaiting QA", "Released to filler", "QA hold", "Reprocess",
         "Destroyed", "Consumed"),  # fmt: skip
        480,
        (
            _field("batch_no", "Batch no", "Text", "reference", required=True),
            _field("batch_date", "Batch date", "Date", "batch_date", required=True),
            _choice("kettle", "Vessel", KETTLES, required=True, value_kind="kettle"),
            _field("cook_temp", "Cook temp °C", "Number", "cook_temp", minimum=0, maximum=150),
            # No tight maximum: the shared trigger test writes the threshold plus one.
            _field("equilibrium_ph", "Equilibrium pH", "Number", "ph", required=True, minimum=0,
                   maximum=14, step=0.01),  # fmt: skip
            _field("brix", "Brix", "Number", "brix", minimum=0, maximum=90),
            _field("viscosity", "Viscosity cP", "Number", "viscosity", minimum=0),
            _field("batch_maker", "Batch maker", "User", "batch_maker"),
            _field("qa_tech", "QA tech", "User", "batch_qa"),
            _check("rework_added", "Rework added"),
        ),
    ),
    _module(
        "shift_reports",
        "Shift Production Report",
        "manufacturing",
        "SPR",
        "Report date",
        ("Draft", "Submitted", "Verified"),
        233,
        (
            _field("report_date", "Report date", "Date", "report_date", required=True),
            _choice("shift", "Shift", SHIFTS, required=True, value_kind="shift"),
            _count("good_units", "Good units", "good_units", required=True, maximum=500_000),
            _count("total_units", "Total units", "total_units", required=True, maximum=500_000),
            _count("planned_min", "Planned min", "planned_min", maximum=720),
            _count("run_min", "Run min", "run_min", maximum=720),
            _count("scrap_units", "Scrap units", "scrap_units", maximum=50_000),
            _field("oee_pct", "OEE %", "Number", "oee", minimum=0, maximum=100),
            _field("line_lead", "Line lead", "User", "line_lead", required=True),
            _flag("needs_review", "Needs review"),
        ),
    ),
    _module(
        "downtime_events",
        "Downtime Event",
        "manufacturing",
        "DT",
        "Event date",
        ("Open", "Coded", "Reviewed"),
        346,
        (
            _field("event_date", "Event date", "Date", "event_date", required=True),
            _field("started_at", "Started at", "Date/Time", "started_at"),
            _count("duration_min", "Duration min", "duration", required=True, maximum=1_440),
            _choice("reason_code", "Reason code", REASON_CODES, required=True,
                    value_kind="reason_code"),  # fmt: skip
            _choice("loss_category", "Loss category", LOSS_CATEGORIES, required=True,
                    value_kind="loss_category"),  # fmt: skip
            _field("reported_by", "Reported by", "User", "reporter"),
            _flag("mwo_required", "Work order required"),
        ),
    ),
)

QUALITY = (
    _module(
        "finished_goods_lots",
        "Finished Goods Lot",
        "quality",
        "FG",
        "Production date",
        ("QA hold, awaiting release", "Released", "Quality hold", "Rework", "Destroyed",
         "Shipped out", "Recalled"),  # fmt: skip
        265,
        (
            _field("lot_code", "Lot code", "Text", "lot_code", required=True),
            _field("production_date", "Production date", "Date", "production_date",
                   required=True),  # fmt: skip
            _field("best_by", "Best-by print", "Text", "best_by", required=True),
            _count("cases_produced", "Cases produced", "cases_produced", required=True),
            _count("cases_on_hand", "Cases on hand", "cases_on_hand"),
            _field("location", "Location", "Text", "fg_location"),
            _field("released_by", "Released by", "User", "releaser"),
            _field("release_date", "Release date", "Date", "release_date"),
        ),
    ),
    _module(
        "food_safety_logs",
        "Food Safety Log",
        "quality",
        "FSL",
        "Log date",
        ("Open", "Completed", "Deviation", "Verified"),
        640,
        (
            _field("log_date", "Log date", "Date", "log_date", required=True),
            _choice("check_type", "Check type", CHECK_TYPES, required=True,
                    value_kind="check_type"),  # fmt: skip
            _choice("shift", "Shift", SHIFTS, value_kind="log_shift"),
            _field("reading", "Reading", "Number", "reading"),
            _check("within_limit", "Within limit"),
            _field("checked_by", "Checked by", "User", "checker", required=True),
            _field("verified_by", "Verified by", "User", "verifier"),
        ),
    ),
    _module(
        "ncrs",
        "Nonconformance Report",
        "quality",
        "NCR",
        "Opened on",
        ("Open", "Contained", "Under review", "Dispositioned", "Closed", "Voided"),
        35,
        (
            _field("ncr_no", "NCR no", "Text", "reference", required=True),
            _field("opened_on", "Opened on", "Date", "ncr_opened", required=True),
            _choice("source", "Source", NCR_SOURCES, required=True, value_kind="ncr_source"),
            _choice("defect_type", "Defect type", DEFECT_TYPES, required=True,
                    value_kind="defect_type"),  # fmt: skip
            _choice("severity", "Severity", SEVERITIES, required=True, value_kind="severity"),
            _field("qty_affected", "Qty affected", "Number", "qty_affected", minimum=0),
            _optional_choice("disposition", "Disposition", DISPOSITIONS, "disposition"),
            _field("containment", "Containment", "Long text", "containment"),
            _money("nonconformance_cost", "Cost of nonconformance $", "ncr_cost"),
            _flag("capa_required", "CAPA required"),
        ),
    ),
    _module(
        "capas",
        "CAPA",
        "quality",
        "CAPA",
        "Opened on",
        ("Open", "Root cause", "Action in progress", "Effectiveness check", "Closed, effective",
         "Reopened", "Cancelled"),  # fmt: skip
        7,
        (
            _field("capa_no", "CAPA no", "Text", "reference", required=True),
            _field("opened_on", "Opened on", "Date", "capa_opened", required=True),
            _field("problem", "Problem statement", "Long text", "problem", required=True),
            _optional_choice("root_cause_method", "Root cause method", ROOT_CAUSE_METHODS,
                             "rca_method"),  # fmt: skip
            _field("root_cause", "Root cause", "Long text", "root_cause"),
            _field("action_plan", "Action plan", "Long text", "action_plan"),
            _field("due_date", "Due date", "Date", "capa_due", required=True),
            _field("effectiveness_check", "Effectiveness check date", "Date", "capa_check"),
        ),
    ),
)
