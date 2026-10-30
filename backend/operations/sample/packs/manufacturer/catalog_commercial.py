"""Sales and Customer Service, and Planning and Purchasing modules (research §4).

Production Orders sit in Planning: the planner creates and releases them (research §3B),
and the production floor reads them.
"""

from __future__ import annotations

from operations.sample.packs.manufacturer.catalog_fields import (
    ALLERGENS,
    CHANNELS,
    FAMILIES,
    FULFILMENT,
    MATERIAL_TYPES,
    PAYMENT_TERMS,
    PRIORITIES,
    SUPPLIER_CATEGORIES,
    UNITS,
    _check,
    _choice,
    _count,
    _field,
    _flag,
    _module,
    _money,
)

SALES = (
    _module(
        "customers",
        "Customer",
        "sales",
        "CUS",
        "Customer since",
        ("Active", "Prospect", "Credit hold", "Inactive"),
        60,
        (
            _field("customer_code", "Customer code", "Text", "reference", required=True),
            _choice("channel", "Channel", CHANNELS, required=True, value_kind="channel"),
            _field("ship_region", "Ship-to region", "Text", "ship_region"),
            _choice("payment_terms", "Payment terms", PAYMENT_TERMS, value_kind="terms"),
            _money("credit_limit", "Credit limit $", "credit_limit"),
            _field("buyer_email", "Buyer email", "Email", "email"),
            _field("phone", "Phone", "Text", "phone"),
            _field(
                "customer_since", "Customer since", "Integer", "since_year", minimum=1980,
                maximum=2030,
            ),  # fmt: skip
        ),
    ),
    _module(
        "sales_orders",
        "Sales Order",
        "sales",
        "SO",
        "Order date",
        ("Draft", "Confirmed", "Allocated", "Partially shipped", "Shipped", "Invoiced",
         "Closed", "On hold", "Cancelled"),  # fmt: skip
        300,
        (
            _field("so_number", "SO number", "Text", "reference", required=True),
            _field("order_date", "Order date", "Date", "order_date", required=True),
            _field("requested_ship", "Requested ship date", "Date", "requested_ship",
                   required=True),  # fmt: skip
            _field("customer_po", "Customer PO", "Text", "customer_po"),
            _choice("fulfilment", "Fulfilment type", FULFILMENT, required=True,
                    value_kind="fulfilment"),  # fmt: skip
            _money("order_value", "Order value $", "order_value"),
            _field("entered_by", "Entered by", "User", "entered_by"),
        ),
    ),
    _module(
        "sales_order_lines",
        "Sales Order Line",
        "sales",
        "SOL",
        "Promised date",
        ("Open", "Allocated", "Backordered", "Shipped", "Cancelled"),
        1_300,
        (
            _field("line_no", "Line no", "Integer", "line_no", required=True, minimum=1,
                   maximum=99),  # fmt: skip
            _field("promised_date", "Promised date", "Date", "promised_date"),
            _count("qty_cases", "Qty cases", "qty_cases", required=True),
            _money("unit_price", "Unit price per case $", "case_price"),
            _field("customer_item", "Customer item code", "Text", "customer_item"),
        ),
    ),
)

PLANNING = (
    _module(
        "products",
        "Product",
        "planning",
        "SKU",
        "Launched",
        ("Active", "Development", "Phase-out", "Discontinued"),
        45,
        (
            _field("sku_code", "SKU code", "Text", "reference", required=True),
            _choice("family", "Family", FAMILIES, required=True, value_kind="family"),
            _field("pack_size", "Pack size", "Text", "pack_size"),
            _count("units_per_case", "Units per case", "units_per_case", maximum=48),
            _count("shelf_life_days", "Shelf life days", "shelf_life", required=True,
                   maximum=1_100),  # fmt: skip
            _check("acidified", "Acidified food"),
            _field("allergens", "Allergens", "Text", "allergens"),
            _money("list_price", "List price per case $", "list_price"),
            _money("standard_cost", "Standard cost per case $", "standard_cost"),
        ),
    ),
    _module(
        "materials",
        "Material",
        "planning",
        "MAT",
        "Last received",
        ("Active", "Blocked", "Obsolete"),
        120,
        (
            _field("item_code", "Item code", "Text", "reference", required=True),
            _choice("material_type", "Type", MATERIAL_TYPES, required=True,
                    value_kind="material_type"),  # fmt: skip
            _choice("uom", "UoM", UNITS, required=True, value_kind="uom"),
            _field("on_hand", "On-hand qty", "Number", "on_hand", minimum=0),
            _field("reorder_point", "Reorder point", "Number", "reorder_point", minimum=0),
            _count("lead_time_days", "Lead time days", "lead_time", maximum=120),
            _choice("allergen", "Allergen", ALLERGENS, value_kind="allergen"),
            _money("contract_price", "Contract price per unit $", "contract_price"),
            _flag("reorder_needed", "Reorder needed"),
        ),
    ),
    _module(
        "boms",
        "Bill of Materials",
        "planning",
        "BOM",
        "Effective since",
        ("Draft", "Pending approval", "Active", "Superseded", "Obsolete"),
        45,
        (
            _field("bom_code", "BOM code", "Text", "reference", required=True),
            _field("version", "Version", "Integer", "version", required=True, minimum=1,
                   maximum=40),  # fmt: skip
            _field("batch_size_kg", "Batch size kg", "Number", "batch_size", required=True,
                   minimum=0),  # fmt: skip
            _field("expected_yield", "Expected yield %", "Number", "yield_pct", minimum=0,
                   maximum=100),  # fmt: skip
            _field("effective_since", "Effective since", "Text", "effective_since"),
            _field("formula", "Formula", "Long text", "formula"),
            _field("approved_by", "Approved by", "User", "bom_approver"),
        ),
    ),
    _module(
        "suppliers",
        "Supplier",
        "planning",
        "SUP",
        "Approved since",
        ("Approved", "Pending approval", "Conditional", "Suspended", "Inactive"),
        40,
        (
            _field("supplier_code", "Supplier code", "Text", "reference", required=True),
            _choice("category", "Category", SUPPLIER_CATEGORIES, value_kind="supplier_category"),
            _field("contact_email", "Contact email", "Email", "email"),
            _field("phone", "Phone", "Text", "phone"),
            _field("country", "Country", "Text", "country"),
            _field("on_time_pct", "On-time delivery %", "Number", "on_time", minimum=0,
                   maximum=100),  # fmt: skip
            _field("certification", "Certification", "Text", "certification"),
            _field("website", "Website", "URL", "url"),
        ),
    ),
    _module(
        "purchase_orders",
        "Purchase Order",
        "planning",
        "PO",
        "Order date",
        ("Draft", "Sent", "Confirmed", "Partially received", "Received", "Closed", "Cancelled"),
        180,
        (
            _field("po_number", "PO number", "Text", "reference", required=True),
            _field("order_date", "Order date", "Date", "po_date", required=True),
            _field("due_date", "Due date", "Date", "po_due", required=True),
            _field("qty", "Qty", "Number", "po_qty", required=True, minimum=0),
            _money("unit_price", "Unit price $", "po_price"),
            _money("po_total", "PO total $", "po_total"),
            _field("buyer", "Buyer", "User", "buyer"),
        ),
    ),
    _module(
        "production_orders",
        "Production Order",
        "planning",
        "WO",
        "Planned start",
        ("Created", "Released", "In progress", "Partially confirmed", "Completed",
         "Technically complete", "Closed", "On hold", "Cancelled"),  # fmt: skip
        190,
        (
            _field("wo_number", "WO number", "Text", "reference", required=True),
            _field("planned_start", "Planned start", "Date", "planned_start", required=True),
            _field("due_date", "Due date", "Date", "wo_due"),
            _count("planned_cases", "Planned qty cases", "planned_cases", required=True),
            _count("completed_cases", "Completed qty cases", "completed_cases"),
            _count("scrap_cases", "Scrap qty cases", "scrap_cases"),
            _choice("priority", "Priority", PRIORITIES, value_kind="priority"),
            _field("planner", "Planner", "User", "planner"),
        ),
    ),
)
