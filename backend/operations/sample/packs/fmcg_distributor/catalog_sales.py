"""Sales and Key Accounts modules: outlets, beats, visits, orders, van tours and schemes."""

from __future__ import annotations

from operations.sample.packs.fmcg_distributor.catalog_fields import (
    CHANNELS,
    NO_ORDER_REASONS,
    PAYMENT_TERMS,
    SCHEME_TYPES,
    WEEKDAYS,
    _check,
    _choice,
    _field,
    _flag,
    _module,
    _optional_choice,
    _peso,
)

SALES = (
    _module(
        "outlets",
        "Outlet",
        "sales",
        "OUT",
        "Last visit",
        ("Active", "Prospect", "On credit hold", "Blocked", "Inactive", "Closed"),
        440,
        (
            _field("outlet_code", "Outlet code", "Text", "reference", required=True),
            _choice("channel", "Channel", CHANNELS, required=True, value_kind="channel"),
            _choice("outlet_class", "Outlet class", ("A", "B", "C"), required=True,
                    value_kind="outlet_class"),  # fmt: skip
            _field("last_visit", "Last visit", "Date", "last_visit"),
            _field("contact", "Owner or contact", "Text", "contact_name"),
            _field("phone", "Phone", "Text", "phone"),
            _field("address", "Address", "Long text", "address"),
            _choice("payment_terms", "Payment terms", PAYMENT_TERMS, required=True,
                    value_kind="payment_terms"),  # fmt: skip
            _peso("credit_limit", "Credit limit ₱", "credit_limit"),
            _field("customer_since", "Customer since", "Integer", "year", minimum=1990),
        ),
    ),
    _module(
        "beats",
        "Beat",
        "sales",
        "BT",
        "Effective from",
        ("Active", "Draft", "Under review", "Retired"),
        18,
        (
            _field("beat_code", "Beat code", "Text", "reference", required=True),
            _field("effective_from", "Effective from", "Date", "effective_from", required=True),
            _field("salesman", "Salesman", "User", "salesman", required=True),
            _choice("route_type", "Route type", ("Pre-sell", "Van sales", "Key account"),
                    required=True, value_kind="route_type"),  # fmt: skip
            _choice("visit_day", "Visit day", WEEKDAYS, required=True, value_kind="visit_day"),
            _field("planned_outlets", "Planned outlets", "Integer", "planned_outlets",
                   minimum=0),  # fmt: skip
            _field("territory", "Territory", "Text", "territory"),
        ),
    ),
    _module(
        "store_visits",
        "Store Visit",
        "sales",
        "VIS",
        "Visit date",
        ("Planned", "In progress", "Completed", "Not visited", "Abandoned"),
        840,
        (
            _field("visit_no", "Visit number", "Text", "reference", required=True),
            _field("visit_date", "Visit date", "Date", "visit_date", required=True),
            _field("salesman", "Salesman", "User", "salesman", required=True),
            _field("checked_in_at", "Check-in time", "Date/Time", "check_in"),
            _choice("visit_type", "Visit type", ("Pre-sell", "Van sales"), required=True,
                    value_kind="visit_type"),  # fmt: skip
            _optional_choice("outcome", "Visit outcome", ("Productive", "No order",
                                                          "Not visited"), "outcome"),
            _optional_choice("no_order_reason", "No-order reason", NO_ORDER_REASONS,
                             "no_order_reason"),  # fmt: skip
        ),
    ),
    _module(
        "sales_orders",
        "Sales Order",
        "sales",
        "SO",
        "Order date",
        ("Draft", "Submitted", "Credit hold", "Confirmed", "Picked", "Dispatched", "Delivered",
         "Partially delivered", "Cancelled", "Rejected by credit"),  # fmt: skip
        340,
        (
            _field("order_no", "Order number", "Text", "reference", required=True),
            _field("order_date", "Order date", "Date", "order_date", required=True),
            _field("requested_delivery", "Requested delivery", "Date", "requested_delivery"),
            _choice("channel", "Channel", ("Pre-sell", "Key account", "Phone or chat"),
                    required=True, value_kind="order_channel"),  # fmt: skip
            _field("booked_by", "Booked by", "User", "booked_by", required=True),
            _choice("payment_terms", "Payment terms", PAYMENT_TERMS, required=True,
                    value_kind="payment_terms"),  # fmt: skip
            _peso("order_total", "Order total ₱", "order_total", required=True),
            _check("scheme_applied", "Scheme applied"),
            _flag("credit_check_required", "Credit check needed"),
        ),
    ),
    _module(
        "order_lines",
        "Sales Order Line",
        "sales",
        "SOL",
        "",
        ("Open", "Allocated", "Delivered", "Short-shipped", "Cancelled"),
        1_560,
        (
            _field("cases", "Cases", "Integer", "cases", required=True, minimum=0),
            _field("pieces", "Loose pieces", "Integer", "pieces", minimum=0),
            _peso("unit_price", "Unit price per case ₱", "unit_price", required=True),
            _field("discount_pct", "Discount %", "Number", "discount_pct", minimum=0,
                   maximum=50, step=0.5),  # fmt: skip
            _field("free_goods", "Free goods (pieces)", "Integer", "free_goods", minimum=0),
            _peso("line_total", "Line total ₱", "line_total", required=True),
        ),
    ),
    _module(
        "route_tours",
        "Route Tour",
        "sales",
        "TOUR",
        "Tour date",
        ("Planned", "Checked out", "Checked in", "Settled", "Variance under review",
         "Cancelled"),  # fmt: skip
        12,
        (
            _field("tour_no", "Tour number", "Text", "reference", required=True),
            _field("tour_date", "Tour date", "Date", "tour_date", required=True),
            _field("van_salesman", "Van salesman", "User", "van_salesman", required=True),
            _peso("load_value", "Load value ₱", "load_value"),
            _peso("sales_value", "Sales value ₱", "sales_value"),
            _peso("cash_remitted", "Cash remitted ₱", "cash_remitted"),
            _field("cash_variance", "Cash variance ₱", "Number", "cash_variance", step=0.01),
            _field("stock_variance", "Stock variance (cases)", "Integer", "stock_variance"),
            _flag("variance_review", "Variance review needed"),
        ),
    ),
)

TRADE = (
    _module(
        "trade_promotions",
        "Trade Promotion",
        "trade_marketing",
        "SCH",
        "Start date",
        ("Draft", "Pending principal approval", "Approved", "Active", "Ended", "Claimed",
         "Cancelled"),  # fmt: skip
        60,
        (
            _field("scheme_code", "Scheme code", "Text", "reference", required=True),
            _field("start_date", "Start date", "Date", "start_date", required=True),
            _field("end_date", "End date", "Date", "end_date", required=True),
            _choice("scheme_type", "Scheme type", SCHEME_TYPES, required=True,
                    value_kind="scheme_type"),  # fmt: skip
            _field("mechanics", "Mechanics", "Long text", "mechanics", required=True),
            _field("eligible_channels", "Eligible channels", "Text", "eligible_channels"),
            _field("budget", "Budget ₱", "Number", "promo_budget", minimum=0),
            _field("claim_deadline", "Claim deadline", "Date", "claim_deadline"),
        ),
    ),
)
