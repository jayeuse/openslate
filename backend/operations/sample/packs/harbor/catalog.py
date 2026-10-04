"""Canonical Harbor Operations departments, modules, and relationships."""

from __future__ import annotations

from operations.sample.packs.types import (
    ActorKey,
    FieldSpec,
    FieldType,
    JsonValue,
    ModuleSpec,
    RelationshipSpec,
    SampleProfile,
)


def _field(
    key: str,
    name: str,
    type_: FieldType,
    value_kind: str,
    required: bool = False,
    options: tuple[str, ...] = (),
    default: JsonValue = None,
    has_default: bool = False,
    minimum: int | float | None = None,
    maximum: int | float | None = None,
    step: int | float | None = None,
) -> FieldSpec:
    return FieldSpec(
        key,
        name,
        type_,
        value_kind,
        required,
        options,
        default,
        has_default,
        minimum,
        maximum,
        step,
    )


def _module(
    key: str,
    department: ActorKey,
    prefix: str,
    date_name: str,
    status_text: str,
    count: int,
    fields: tuple[FieldSpec, ...],
) -> ModuleSpec:
    statuses = tuple(status_text.split("|"))
    name = key.replace("_", " ").title()
    common = (
        _field("name", "Name", "Text", "title", required=True),
        _field("reference", "Reference", "Text", "reference"),
        _field(
            "status",
            "Status",
            "Select",
            "status",
            options=statuses,
            default=statuses[0],
            has_default=True,
        ),
        _field("activity_date", date_name, "Date", "date"),
        _field("owner", "Assigned to", "User", "owner"),
        _field("notes", "Notes", "Long text", "notes", default="", has_default=True),
    )
    return ModuleSpec(key, name, department, prefix, date_name, statuses, count, common + fields)


# fmt: off
_MODULES = (
    _module('customers', 'sales', 'CUS', 'Onboarded on',
        'Active|Prospect|On hold', 300, (
        _field('email', 'Billing email', 'Email', 'email', False, (), '', True),
        _field('website', 'Website', 'URL', 'url', False, (), '', True),
        _field('credit_limit', 'Credit limit', 'Number', 'amount', False, (), 0, True, 0),
        _field('segment', 'Segment', 'Select', 'choice',
            False, ('Marine', 'Food service', 'Agriculture', 'Public sector')),
    )),
    _module('contacts', 'sales', 'CON', 'Last contacted',
        'Active|Do not contact|Former', 600, (
        _field('email', 'Email', 'Email', 'email', True),
        _field('role', 'Role', 'Select', 'choice',
            False, ('Buyer', 'Operations', 'Finance', 'Executive')),
        _field('mobile', 'Mobile phone', 'Text', 'phone'),
        _field('preferred_contact', 'Preferred contact', 'Checkbox', 'boolean',
            False, (), False, True),
    )),
    _module('quotes', 'sales', 'QUO', 'Valid until',
        'Draft|Sent|Accepted|Expired|Cancelled', 800, (
        _field('total', 'Total', 'Number', 'amount', False, (), None, False, 0),
        _field('sent_at', 'Sent at', 'Date/Time', 'datetime'),
        _field('accepted', 'Customer accepted', 'Checkbox', 'boolean', False, (), False, True),
        _field('terms', 'Payment terms', 'Select', 'choice', False, ('Net 15', 'Net 30', 'Net 45')),
    )),
    _module('sales_orders', 'sales', 'SO', 'Ordered on',
        'Draft|Confirmed|Partially fulfilled|Complete|Cancelled', 2000, (
        _field('total', 'Total', 'Number', 'amount', False, (), None, False, 0),
        _field('quantity', 'Units ordered', 'Integer', 'integer',
            False, (), None, False, 0, None, 1),
        _field('promised_at', 'Promised delivery', 'Date/Time', 'datetime'),
        _field('priority', 'Priority', 'Select', 'choice',
            False, ('Standard', 'Expedite', 'Critical')),
        _field('fulfilled', 'Fulfilled', 'Checkbox', 'boolean', False, (), False, True),
    )),
    _module('customer_sites', 'service', 'SITE', 'Opened on',
        'Active|Seasonal|Closed', 300, (
        _field('address', 'Site address', 'Long text', 'notes'),
        _field('site_type', 'Site type', 'Select', 'choice',
            False, ('Office', 'Warehouse', 'Plant', 'Retail')),
        _field('latitude', 'Latitude', 'Number', 'number', False, (), None, False, -90, 90),
        _field('website', 'Site portal', 'URL', 'url', False, (), '', True),
    )),
    _module('service_contracts', 'service', 'SC', 'Renewal date',
        'Active|Renewal due|Expired|Cancelled', 200, (
        _field('annual_value', 'Annual value', 'Number', 'amount', False, (), None, False, 0),
        _field('signed_at', 'Signed at', 'Date/Time', 'datetime'),
        _field('auto_renew', 'Auto renew', 'Checkbox', 'boolean', False, (), False, True),
        _field('coverage', 'Coverage', 'Long text', 'notes'),
    )),
    _module('service_requests', 'service', 'SR', 'Due date',
        'Open|In progress|Overdue|Resolved|Cancelled', 1200, (
        _field('priority', 'Priority', 'Select', 'choice',
            False, ('Routine', 'Urgent', 'Emergency')),
        _field('estimated_cost', 'Estimated cost', 'Number', 'amount', False, (), None, False, 0),
        _field('requested_at', 'Requested at', 'Date/Time', 'datetime'),
        _field('customer_email', 'Requester email', 'Email', 'email', False, (), '', True),
    )),
    _module('request_updates', 'service', 'UPD', 'Updated on',
        'Internal|Customer visible|Resolved', 1400, (
        _field('update', 'Update', 'Long text', 'notes', True),
        _field('minutes', 'Minutes spent', 'Integer', 'integer',
            False, (), None, False, 0, None, 1),
        _field('visible', 'Visible to customer', 'Checkbox', 'boolean', False, (), False, True),
    )),
    _module('equipment', 'field', 'EQ', 'Commissioned on',
        'Operational|Needs service|Retired', 600, (
        _field('serial', 'Serial number', 'Text', 'reference'),
        _field('purchase_price', 'Purchase price', 'Number', 'amount', False, (), None, False, 0),
        _field('manual', 'Service manual', 'URL', 'url', False, (), '', True),
        _field('active', 'In service', 'Checkbox', 'boolean', False, (), False, True),
    )),
    _module('work_orders', 'field', 'WO', 'Due date',
        'Open|Scheduled|Overdue|In progress|Completed|Cancelled', 2000, (
        _field('labor_hours', 'Labor hours', 'Number', 'number', False, (), None, False, 0, 1000),
        _field('scheduled_at', 'Scheduled for', 'Date/Time', 'datetime'),
        _field('safety_verified', 'Safety verified', 'Checkbox', 'boolean', False, (), False, True),
        _field('follow_up', 'Follow-up required', 'Checkbox', 'boolean', False, (), False, True),
    )),
    _module('inspections', 'field', 'INSP', 'Inspected on',
        'Passed|Needs repair|Follow-up', 1000, (
        _field('score', 'Condition score', 'Number', 'number', False, (), None, False, 0, 100),
        _field('inspector_email', 'Inspector email', 'Email', 'email', False, (), '', True),
        _field('findings', 'Findings', 'Long text', 'notes'),
    )),
    _module('maintenance_plans', 'field', 'MP', 'Next due',
        'Active|Scheduled|On hold', 200, (
        _field('interval_days', 'Interval days', 'Integer', 'integer',
            False, (), None, False, 1, 365, 1),
        _field('procedure', 'Procedure', 'Long text', 'notes'),
        _field('enabled', 'Enabled', 'Checkbox', 'boolean', False, (), True, True),
    )),
    _module('products', 'inventory', 'SKU', 'Introduced on',
        'Available|Low stock|Discontinued', 500, (
        _field('unit_price', 'Unit price', 'Number', 'product_price', False, (), None, False, 0),
        _field('reorder_point', 'Reorder point', 'Integer', 'integer',
            False, (), 0, True, 0, None, 1),
        _field('category', 'Category', 'Select', 'choice',
            False, ('Electrical', 'Hydraulics', 'Safety', 'Packaging')),
        _field('product_url', 'Product page', 'URL', 'url', False, (), '', True),
    )),
    _module('warehouses', 'inventory', 'WH', 'Opened on',
        'Active|Temporarily closed', 10, (
        _field('region', 'Region', 'Select', 'choice',
            False, ('Metro Manila', 'Central Luzon', 'Central Visayas', 'Davao')),
        _field('capacity', 'Pallet capacity', 'Integer', 'integer',
            False, (), None, False, 0, None, 1),
        _field('email', 'Warehouse email', 'Email', 'email', False, (), '', True),
    )),
    _module('stock_movements', 'inventory', 'MOV', 'Moved on',
        'Received|Transferred|Adjusted', 3500, (
        _field('quantity', 'Quantity', 'Integer', 'movement_quantity',
            False, (), None, False, 1, None, 1),
        _field('unit_cost', 'Unit cost', 'Number', 'movement_cost', False, (), None, False, 0),
        _field('cycle_count', 'Cycle count required', 'Checkbox', 'boolean',
            False, (), False, True),
        _field('reason', 'Movement reason', 'Select', 'choice',
            False, ('Purchase receipt', 'Quality check', 'Put away')),
    )),
    _module('stock_counts', 'inventory', 'COUNT', 'Counted on',
        'Open|Variance found|Reconciled', 490, (
        _field('variance', 'Variance', 'Integer', 'variance',
            False, (), None, False, None, None, 1),
        _field('recount', 'Recount required', 'Checkbox', 'boolean', False, (), False, True),
        _field('count_notes', 'Count notes', 'Long text', 'notes'),
    )),
    _module('suppliers', 'purchasing', 'SUP', 'Approved on',
        'Active|Pending review|On hold', 100, (
        _field('email', 'Purchasing email', 'Email', 'email', True),
        _field('website', 'Website', 'URL', 'url', False, (), '', True),
        _field('terms_days', 'Payment terms days', 'Integer', 'integer',
            False, (), None, False, 0, 120, 1),
        _field('risk_score', 'Risk score', 'Number', 'number', False, (), None, False, 0, 100),
    )),
    _module('purchase_orders', 'purchasing', 'PO', 'Expected delivery',
        'Draft|Confirmed|Partially received|Received|Delayed|Cancelled', 700, (
        _field('total', 'Total', 'Number', 'purchase_total', False, (), None, False, 0),
        _field('urgent', 'Expedite', 'Checkbox', 'boolean', False, (), False, True),
        _field('confirmed_at', 'Confirmed at', 'Date/Time', 'datetime'),
    )),
    _module('purchase_lines', 'purchasing', 'POL', 'Required by',
        'Open|Partially received|Received|Cancelled', 1400, (
        _field('quantity', 'Quantity', 'Integer', 'ordered_quantity',
            False, (), None, False, 1, None, 1),
        _field('unit_price', 'Unit price', 'Number', 'purchase_unit_price',
            False, (), None, False, 0),
        _field('line_total', 'Line total', 'Number', 'line_total', False, (), None, False, 0),
    )),
    _module('goods_receipts', 'purchasing', 'GR', 'Received on',
        'Accepted|Partial|Discrepancy recorded', 700, (
        _field('units_accepted', 'Units accepted', 'Integer', 'accepted_quantity',
            False, (), None, False, 1, None, 1),
        _field('received_at', 'Received at', 'Date/Time', 'receipt_datetime'),
        _field('condition', 'Condition notes', 'Long text', 'notes'),
    )),
    _module('invoices', 'finance', 'INV', 'Due date',
        'Draft|Issued|Partially paid|Paid|Overdue|Disputed|Cancelled', 800, (
        _field('total', 'Total', 'Number', 'invoice_total', False, (), None, False, 0),
        _field('issued_at', 'Issued at', 'Date/Time', 'datetime'),
        _field('review_required', 'Review required', 'Checkbox', 'boolean', False, (), False, True),
        _field('billing_email', 'Billing email', 'Email', 'email', False, (), '', True),
    )),
    _module('payments', 'finance', 'PAY', 'Paid on',
        'Posted|Pending|Failed|Refunded', 600, (
        _field('amount', 'Amount', 'Number', 'payment_amount', False, (), None, False, 0),
        _field('posted_at', 'Posted at', 'Date/Time', 'datetime'),
        _field('method', 'Method', 'Select', 'choice', False, ('Bank transfer', 'Card', 'Cheque')),
        _field('posted', 'Posted', 'Checkbox', 'boolean', False, (), False, True),
    )),
    _module('expenses', 'finance', 'EXP', 'Incurred on',
        'Submitted|Approved|Rejected|Reimbursed', 500, (
        _field('amount', 'Amount', 'Number', 'expense_amount', False, (), None, False, 0),
        _field('category', 'Category', 'Select', 'choice',
            False, ('Travel', 'Supplies', 'Maintenance', 'Meals')),
        _field('submitted_at', 'Submitted at', 'Date/Time', 'datetime'),
        _field('reimbursed', 'Reimbursed', 'Checkbox', 'boolean', False, (), False, True),
        _field('justification', 'Business justification', 'Long text', 'notes'),
    )),
    _module('credit_notes', 'finance', 'CN', 'Issued on',
        'Draft|Approved|Issued|Cancelled', 100, (
        _field('amount', 'Amount', 'Number', 'credit_amount', False, (), None, False, 0),
        _field('issued_at', 'Issued at', 'Date/Time', 'datetime'),
        _field('reason', 'Reason', 'Long text', 'notes', True),
    )),
)
# fmt: on
_DEPARTMENTS = (
    ("sales", "Sales"),
    ("service", "Customer Service"),
    ("field", "Field Operations"),
    ("inventory", "Inventory"),
    ("purchasing", "Purchasing"),
    ("finance", "Finance"),
)
_RELATIONSHIPS = (
    RelationshipSpec("customer_contacts", "Contacts", "customers", "contacts", "one-to-many"),
    RelationshipSpec("customer_quotes", "Quotes", "customers", "quotes", "one-to-many"),
    RelationshipSpec("customer_orders", "Sales orders", "customers", "sales_orders", "one-to-many"),
    RelationshipSpec(
        "site_contracts", "Service contracts", "customer_sites", "service_contracts", "one-to-many"
    ),
    RelationshipSpec(
        "site_requests", "Service requests", "customer_sites", "service_requests", "one-to-many"
    ),
    RelationshipSpec(
        "request_updates", "Request updates", "service_requests", "request_updates", "one-to-many"
    ),
    RelationshipSpec(
        "equipment_work_orders", "Work orders", "equipment", "work_orders", "many-to-many"
    ),
    RelationshipSpec(
        "work_order_inspections", "Inspections", "work_orders", "inspections", "one-to-one"
    ),
    RelationshipSpec(
        "equipment_plans", "Maintenance plans", "equipment", "maintenance_plans", "one-to-many"
    ),
    RelationshipSpec(
        "supplier_orders", "Purchase orders", "suppliers", "purchase_orders", "one-to-many"
    ),
    RelationshipSpec(
        "purchase_order_lines", "Purchase lines", "purchase_orders", "purchase_lines", "one-to-many"
    ),
    RelationshipSpec(
        "purchase_order_receipts",
        "Goods receipts",
        "purchase_orders",
        "goods_receipts",
        "one-to-many",
    ),
    RelationshipSpec(
        "warehouse_movements", "Stock movements", "warehouses", "stock_movements", "one-to-many"
    ),
    RelationshipSpec(
        "product_movements", "Stock movements", "products", "stock_movements", "one-to-many"
    ),
    RelationshipSpec(
        "warehouse_counts", "Stock counts", "warehouses", "stock_counts", "one-to-many"
    ),
    RelationshipSpec("product_counts", "Stock counts", "products", "stock_counts", "one-to-many"),
    RelationshipSpec("invoice_payments", "Payments", "invoices", "payments", "one-to-many"),
    RelationshipSpec("invoice_credits", "Credit notes", "invoices", "credit_notes", "one-to-many"),
    # Links to records in another department. The referencing record is the source and is
    # created after the record it names, so it is the child end.
    RelationshipSpec(
        "site_customer", "Customer", "customer_sites", "customers", "one-to-one", child="source"
    ),
    RelationshipSpec(
        "invoice_customer", "Customer", "invoices", "customers", "many-to-many", child="source"
    ),
    RelationshipSpec(
        "invoice_sales_order",
        "Sales order",
        "invoices",
        "sales_orders",
        "one-to-one",
        child="source",
    ),
    RelationshipSpec(
        "request_equipment",
        "Equipment",
        "service_requests",
        "equipment",
        "many-to-many",
        child="source",
    ),
    RelationshipSpec(
        "line_product", "Product", "purchase_lines", "products", "many-to-many", child="source"
    ),
    RelationshipSpec(
        "movement_receipt",
        "Goods receipt",
        "stock_movements",
        "goods_receipts",
        "many-to-many",
        child="source",
    ),
    RelationshipSpec(
        "order_warehouse",
        "Warehouse",
        "purchase_orders",
        "warehouses",
        "many-to-many",
        child="source",
    ),
    RelationshipSpec(
        "work_order_products",
        "Products used",
        "work_orders",
        "products",
        "many-to-many",
        child="source",
    ),
)

SPECIAL_STATUSES = {
    "quotes": {3: "Cancelled"},
    "sales_orders": {0: "Partially fulfilled", 1_000: "Cancelled"},
    "service_requests": {0: "Overdue", 1: "Cancelled"},
    "work_orders": {0: "Overdue", 3: "Cancelled"},
    "service_contracts": {3: "Cancelled"},
}

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}


def _ceil_divide(value: int, divisor: int) -> int:
    return (value + divisor - 1) // divisor


_SCALED_STANDARD_COUNTS = {key: _ceil_divide(count, 4) for key, count in _STANDARD_COUNTS.items()}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {
        key: max(1, _ceil_divide(count, 5)) for key, count in _SCALED_STANDARD_COUNTS.items()
    },
    "standard": _SCALED_STANDARD_COUNTS,
    "large": {key: count * 4 for key, count in _SCALED_STANDARD_COUNTS.items()},
}
LEGACY_PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, _ceil_divide(count, 20)) for key, count in _STANDARD_COUNTS.items()},
    "standard": _STANDARD_COUNTS,
    "large": {key: count * 5 for key, count in _STANDARD_COUNTS.items()},
}
