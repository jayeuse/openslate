"""Purchasing, Warehouse and Logistics modules: principals to stock, returns and the fleet."""

from __future__ import annotations

from operations.sample.packs.fmcg_distributor.catalog_fields import (
    ADJUSTMENT_REASONS,
    BO_REASONS,
    COUNT_TYPES,
    DISPOSITIONS,
    EXPIRY_BANDS,
    PRINCIPAL_CATEGORIES,
    VEHICLE_TYPES,
    _choice,
    _field,
    _flag,
    _module,
    _optional_choice,
    _peso,
)

PURCHASING = (
    _module(
        "principals",
        "Principal",
        "purchasing",
        "PRN",
        "Agreement renewed",
        ("Active", "Onboarding", "On hold", "Terminated"),
        12,
        (
            _field("principal_code", "Principal code", "Text", "reference", required=True),
            _choice("category", "Category", PRINCIPAL_CATEGORIES, required=True,
                    value_kind="principal_category"),  # fmt: skip
            _field("renewed_on", "Agreement renewed", "Date", "renewed_on"),
            _field("account_manager", "Principal account manager", "Text", "account_manager"),
            _field("email", "Email", "Email", "email"),
            _field("portal", "Order portal", "URL", "url"),
            _choice("payment_terms", "Payment terms", ("30 days", "45 days", "60 days"),
                    value_kind="principal_terms"),  # fmt: skip
        ),
    ),
    _module(
        "products",
        "Product",
        "purchasing",
        "SKU",
        "Price effective",
        ("Active", "New listing", "Phase-out", "Delisted", "Recalled"),
        300,
        (
            _field("sku_code", "SKU code", "Text", "reference", required=True),
            _field("price_effective", "Price effective", "Date", "price_effective"),
            _field("gtin_each", "GTIN (each)", "Text", "gtin_each"),
            _field("gtin_case", "GTIN (case)", "Text", "gtin_case"),
            _field("pieces_per_case", "Pieces per case", "Integer", "pieces_per_case",
                   required=True, minimum=1),  # fmt: skip
            _peso("list_price", "List price per case ₱", "list_price", required=True),
            _field("shelf_life_days", "Shelf life (days)", "Integer", "shelf_life",
                   required=True, minimum=1),  # fmt: skip
            _choice("abc_class", "ABC class", ("A", "B", "C"), value_kind="abc_class"),
        ),
    ),
    _module(
        "purchase_orders",
        "Purchase Order",
        "purchasing",
        "PO",
        "PO date",
        ("Draft", "Pending approval", "Approved", "Sent to principal", "Partially received",
         "Received", "Closed", "Rejected", "Cancelled"),  # fmt: skip
        55,
        (
            _field("po_no", "PO number", "Text", "reference", required=True),
            _field("po_date", "PO date", "Date", "po_date", required=True),
            _field("expected_delivery", "Expected delivery", "Date", "expected_delivery"),
            _peso("po_total", "PO total ₱", "po_total", required=True),
            _field("raised_by", "Raised by", "User", "raised_by", required=True),
            _field("approved_by", "Approved by", "User", "approver"),
            _flag("approval_required", "Approval needed"),
        ),
    ),
    _module(
        "po_lines",
        "PO Line",
        "purchasing",
        "POL",
        "",
        ("Open", "Partially received", "Received", "Short-closed"),
        330,
        (
            _field("cases_ordered", "Cases ordered", "Integer", "cases_ordered", required=True,
                   minimum=1),  # fmt: skip
            _field("cases_received", "Cases received", "Integer", "cases_received", minimum=0),
            _peso("unit_cost", "Unit cost per case ₱", "unit_cost", required=True),
            _peso("line_total", "Line total ₱", "po_line_total", required=True),
        ),
    ),
)

WAREHOUSE = (
    _module(
        "goods_receipts",
        "Goods Receipt",
        "warehouse",
        "GRN",
        "Received on",
        ("Draft", "Counting", "Posted", "Posted with discrepancy", "Reversed"),
        62,
        (
            _field("grn_no", "GRN number", "Text", "reference", required=True),
            _field("received_on", "Received on", "Date", "received_on", required=True),
            _field("received_by", "Received by", "User", "received_by", required=True),
            _field("principal_dr", "Principal DR number", "Text", "principal_dr"),
            _field("pallet_sscc", "Pallet SSCC", "Text", "sscc"),
            _field("discrepancy_note", "Discrepancy note", "Long text", "discrepancy_note"),
            _flag("claim_required", "Short-delivery claim needed"),
        ),
    ),
    _module(
        "stock_lots",
        "Stock Lot",
        "warehouse",
        "LOT",
        "Received on",
        ("Available", "Pick first (FEFO)", "Quarantine", "Blocked", "Returned to principal",
         "Depleted"),  # fmt: skip
        300,
        (
            _field("lot_no", "Lot number", "Text", "lot_no", required=True),
            _field("received_on", "Received on", "Date", "lot_received_on", required=True),
            _field("expiry", "Expiry (month/year)", "Text", "expiry_month", required=True),
            _choice("expiry_band", "Expiry band", EXPIRY_BANDS, required=True,
                    value_kind="expiry_band"),  # fmt: skip
            _field("cases_on_hand", "Cases on hand", "Integer", "cases_on_hand", required=True,
                   minimum=0),  # fmt: skip
            _field("bin_location", "Bin location", "Text", "bin_location"),
            _flag("near_expiry_alert", "Near-expiry alert"),
        ),
    ),
    _module(
        "stock_counts",
        "Stock Count",
        "warehouse",
        "SC",
        "Count date",
        ("Scheduled", "Counted", "Recount required", "Approved", "Posted"),
        180,
        (
            _field("count_no", "Count number", "Text", "reference", required=True),
            _field("count_date", "Count date", "Date", "count_date", required=True),
            _choice("count_type", "Count type", COUNT_TYPES, required=True,
                    value_kind="count_type"),  # fmt: skip
            _field("counted_by", "Counted by", "User", "counted_by", required=True),
            _field("system_qty", "System qty (cases)", "Integer", "system_qty", minimum=0),
            _field("counted_qty", "Counted qty (cases)", "Integer", "counted_qty", minimum=0),
            _field("variance_pct", "Variance %", "Number", "variance_pct", step=0.1),
            _flag("recount_required", "Recount needed"),
            _flag("weekly_review", "Weekly count review"),
        ),
    ),
    _module(
        "stock_adjustments",
        "Stock Adjustment",
        "warehouse",
        "ADJ",
        "Adjusted on",
        ("Draft", "Pending approval", "Approved", "Posted", "Rejected"),
        45,
        (
            _field("adj_no", "Adjustment number", "Text", "reference", required=True),
            _field("adjusted_on", "Adjusted on", "Date", "adjusted_on", required=True),
            _field("cases", "Cases (+ or −)", "Integer", "adjust_cases", required=True),
            _field("value", "Value ₱", "Number", "adjust_value", step=0.01),
            _choice("reason", "Reason", ADJUSTMENT_REASONS, required=True,
                    value_kind="adjust_reason"),  # fmt: skip
            _field("requested_by", "Requested by", "User", "requested_by", required=True),
            _field("approved_by", "Approved by", "User", "approver"),
        ),
    ),
    _module(
        "returns",
        "Return",
        "warehouse",
        "BO",
        "Reported on",
        ("Requested", "Authorized", "Picked up", "Received", "Inspected", "Credited",
         "Replaced", "Rejected", "Cancelled"),  # fmt: skip
        90,
        (
            _field("return_no", "Return number", "Text", "reference", required=True),
            _field("reported_on", "Reported on", "Date", "reported_on", required=True),
            _field("reported_by", "Reported by", "User", "reported_by", required=True),
            _field("pickup_date", "Pickup date", "Date", "pickup_date"),
            _peso("return_value", "Return value ₱", "return_value"),
            _choice("reason", "Reason", BO_REASONS, required=True, value_kind="bo_reason"),
            _optional_choice("disposition", "Disposition", DISPOSITIONS, "disposition"),
        ),
    ),
)

LOGISTICS = (
    _module(
        "delivery_trips",
        "Delivery Trip",
        "logistics",
        "TRIP",
        "Trip date",
        ("Planned", "Loading", "Dispatched", "In transit", "Returned to depot", "Closed",
         "Cancelled"),  # fmt: skip
        17,
        (
            _field("trip_no", "Trip number", "Text", "reference", required=True),
            _field("trip_date", "Trip date", "Date", "trip_date", required=True),
            _field("driver", "Driver", "User", "driver", required=True),
            _field("drops_planned", "Drops planned", "Integer", "drops_planned", minimum=0),
            _field("drops_completed", "Drops completed", "Integer", "drops_completed",
                   minimum=0),  # fmt: skip
        ),
    ),
    _module(
        "vehicles",
        "Vehicle",
        "logistics",
        "VEH",
        "Next PMS due",
        ("Available", "On trip", "Under maintenance", "Out of service"),
        16,
        (
            _field("plate_no", "Plate number", "Text", "plate_no", required=True),
            _field("next_pms_due", "Next PMS due", "Date", "next_pms_due"),
            _choice("vehicle_type", "Vehicle type", VEHICLE_TYPES, required=True,
                    value_kind="vehicle_type"),  # fmt: skip
            _field("capacity_cases", "Capacity (cases)", "Integer", "capacity", minimum=0),
            _field("registration_month", "Registration month", "Text", "registration_month"),
            _field("odometer_km", "Odometer (km)", "Integer", "odometer", minimum=0),
        ),
    ),
)
