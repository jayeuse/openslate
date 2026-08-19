"""Populate a development database with the sample OpenSlate domain data."""

import json
import os
from collections.abc import Mapping
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from app.core.config import get_settings

ROLE_SPECS = {
    "admin": {"admin": True},
    "manager": {"records": {"read": True, "create": True, "update": True}},
    "staff": {"records": {"read": True, "create": True}},
}

DEPARTMENT_SPECS = {
    "dept-inv": "Inventory",
    "dept-acc": "Accounting",
    "dept-sales": "Sales",
}

MODULE_SPECS = {
    "mod-products": ("dept-inv", "Inventory Catalog"),
    "mod-suppliers": ("dept-inv", "Suppliers"),
    "mod-stock": ("dept-inv", "Stock Movements"),
    "mod-trans": ("dept-acc", "Transactions"),
    "mod-exp": ("dept-acc", "Expenses"),
    "mod-payable": ("dept-acc", "Accounts Payable"),
    "mod-customers": ("dept-sales", "Customers"),
    "mod-orders": ("dept-sales", "Sales Orders"),
    "mod-payments": ("dept-sales", "Payments"),
}

FIELD_SPECS = [
    ("field-prod-name", "mod-products", "Product Name", "text", True, 1, {}),
    ("field-prod-price", "mod-products", "Price", "decimal", True, 2, {"minimum": 0}),
    ("field-prod-stock", "mod-products", "Stock", "int", True, 3, {"minimum": 0}),
    (
        "field-prod-cat",
        "mod-products",
        "Category",
        "select",
        False,
        4,
        {"options": ["Drink", "Food", "Other"]},
    ),
    (
        "field-prod-status",
        "mod-products",
        "Status",
        "select",
        True,
        5,
        {"options": ["Available", "Low Stock", "Out of Stock"]},
    ),
    ("field-sup-name", "mod-suppliers", "Supplier Name", "text", True, 1, {}),
    ("field-sup-contact", "mod-suppliers", "Contact Number", "text", False, 2, {}),
    ("field-sup-email", "mod-suppliers", "Email", "text", False, 3, {}),
    (
        "field-sup-status",
        "mod-suppliers",
        "Status",
        "select",
        True,
        4,
        {"options": ["Active", "Inactive"]},
    ),
    ("field-stock-product", "mod-stock", "Product", "text", True, 1, {}),
    ("field-stock-qty", "mod-stock", "Quantity", "int", True, 2, {}),
    (
        "field-stock-type",
        "mod-stock",
        "Movement Type",
        "select",
        True,
        3,
        {"options": ["Stock In", "Stock Out"]},
    ),
    ("field-stock-date", "mod-stock", "Date", "datetime", True, 4, {}),
    ("field-stock-remarks", "mod-stock", "Remarks", "text", False, 5, {}),
    ("field-trans-name", "mod-trans", "Transaction", "text", True, 1, {}),
    ("field-trans-amount", "mod-trans", "Amount", "decimal", True, 2, {}),
    (
        "field-trans-type",
        "mod-trans",
        "Type",
        "select",
        True,
        3,
        {"options": ["Income", "Expense"]},
    ),
    ("field-trans-date", "mod-trans", "Date", "datetime", True, 4, {}),
    ("field-exp-name", "mod-exp", "Expense", "text", True, 1, {}),
    ("field-exp-cost", "mod-exp", "Cost", "decimal", True, 2, {"minimum": 0}),
    (
        "field-exp-category",
        "mod-exp",
        "Category",
        "select",
        True,
        3,
        {"options": ["Utilities", "Supplies", "Rent", "Other"]},
    ),
    ("field-exp-due", "mod-exp", "Due Date", "datetime", True, 4, {}),
    ("field-exp-paid", "mod-exp", "Paid", "boolean", True, 5, {}),
    ("field-customer-name", "mod-customers", "Customer Name", "text", True, 1, {}),
    ("field-customer-contact", "mod-customers", "Contact Number", "text", False, 2, {}),
    ("field-customer-address", "mod-customers", "Address", "text", False, 3, {}),
    (
        "field-customer-status",
        "mod-customers",
        "Status",
        "select",
        True,
        4,
        {"options": ["Active", "Inactive"]},
    ),
    ("field-order-number", "mod-orders", "Order Number", "text", True, 1, {}),
    ("field-order-customer", "mod-orders", "Customer", "text", True, 2, {}),
    ("field-order-total", "mod-orders", "Total", "decimal", True, 3, {"minimum": 0}),
    ("field-order-date", "mod-orders", "Order Date", "datetime", True, 4, {}),
    (
        "field-order-status",
        "mod-orders",
        "Status",
        "select",
        True,
        5,
        {"options": ["Pending", "Completed", "Cancelled"]},
    ),
]

RECORD_SPECS = [
    (
        "rec-001",
        "mod-products",
        {
            "field-prod-name": "Coca-Cola 1.5L",
            "field-prod-price": 75.0,
            "field-prod-stock": 20,
            "field-prod-cat": "Drink",
            "field-prod-status": "Available",
        },
    ),
    (
        "rec-002",
        "mod-products",
        {
            "field-prod-name": "Potato Chips",
            "field-prod-price": 35.5,
            "field-prod-stock": 4,
            "field-prod-cat": "Food",
            "field-prod-status": "Low Stock",
        },
    ),
    (
        "rec-003",
        "mod-products",
        {
            "field-prod-name": "Bottled Water",
            "field-prod-price": 20.0,
            "field-prod-stock": 0,
            "field-prod-cat": "Drink",
            "field-prod-status": "Out of Stock",
        },
    ),
    (
        "rec-sup-001",
        "mod-suppliers",
        {
            "field-sup-name": "Metro Wholesale",
            "field-sup-contact": "09171234567",
            "field-sup-email": "sales@metro.example",
            "field-sup-status": "Active",
        },
    ),
    (
        "rec-sup-002",
        "mod-suppliers",
        {
            "field-sup-name": "ABC Distribution",
            "field-sup-contact": "09181234567",
            "field-sup-email": "orders@abc.example",
            "field-sup-status": "Active",
        },
    ),
    (
        "rec-stock-001",
        "mod-stock",
        {
            "field-stock-product": "Coca-Cola 1.5L",
            "field-stock-qty": 20,
            "field-stock-type": "Stock In",
            "field-stock-date": "2026-08-19T09:00:00+08:00",
            "field-stock-remarks": "Supplier delivery",
        },
    ),
    (
        "rec-stock-002",
        "mod-stock",
        {
            "field-stock-product": "Potato Chips",
            "field-stock-qty": 3,
            "field-stock-type": "Stock Out",
            "field-stock-date": "2026-08-19T11:30:00+08:00",
            "field-stock-remarks": "Sold",
        },
    ),
    (
        "rec-stock-003",
        "mod-stock",
        {
            "field-stock-product": "Bottled Water",
            "field-stock-qty": 24,
            "field-stock-type": "Stock In",
            "field-stock-date": "2026-08-19T13:00:00+08:00",
            "field-stock-remarks": "Restock",
        },
    ),
    (
        "rec-trans-001",
        "mod-trans",
        {
            "field-trans-name": "Daily Sales",
            "field-trans-amount": 12450.0,
            "field-trans-type": "Income",
            "field-trans-date": "2026-08-19T17:00:00+08:00",
        },
    ),
    (
        "rec-trans-002",
        "mod-trans",
        {
            "field-trans-name": "Supplier Payment",
            "field-trans-amount": 4000.0,
            "field-trans-type": "Expense",
            "field-trans-date": "2026-08-19T15:00:00+08:00",
        },
    ),
    (
        "rec-trans-003",
        "mod-trans",
        {
            "field-trans-name": "Delivery Fee",
            "field-trans-amount": 500.0,
            "field-trans-type": "Expense",
            "field-trans-date": "2026-08-19T16:00:00+08:00",
        },
    ),
    (
        "rec-exp-001",
        "mod-exp",
        {
            "field-exp-name": "Electricity",
            "field-exp-cost": 4500.0,
            "field-exp-category": "Utilities",
            "field-exp-due": "2026-08-30T23:59:59+08:00",
            "field-exp-paid": False,
        },
    ),
    (
        "rec-exp-002",
        "mod-exp",
        {
            "field-exp-name": "Internet",
            "field-exp-cost": 1699.0,
            "field-exp-category": "Utilities",
            "field-exp-due": "2026-08-25T23:59:59+08:00",
            "field-exp-paid": True,
        },
    ),
    (
        "rec-exp-003",
        "mod-exp",
        {
            "field-exp-name": "Store Rent",
            "field-exp-cost": 12000.0,
            "field-exp-category": "Rent",
            "field-exp-due": "2026-09-01T23:59:59+08:00",
            "field-exp-paid": False,
        },
    ),
    (
        "rec-customer-001",
        "mod-customers",
        {
            "field-customer-name": "Juan Dela Cruz",
            "field-customer-contact": "09171234567",
            "field-customer-address": "Manila",
            "field-customer-status": "Active",
        },
    ),
    (
        "rec-customer-002",
        "mod-customers",
        {
            "field-customer-name": "Maria Santos",
            "field-customer-contact": "09181234567",
            "field-customer-address": "Pasig",
            "field-customer-status": "Active",
        },
    ),
    (
        "rec-customer-003",
        "mod-customers",
        {
            "field-customer-name": "Pedro Reyes",
            "field-customer-contact": "09191234567",
            "field-customer-address": "Makati",
            "field-customer-status": "Inactive",
        },
    ),
    (
        "rec-order-001",
        "mod-orders",
        {
            "field-order-number": "SO-1001",
            "field-order-customer": "Juan Dela Cruz",
            "field-order-total": 1250.0,
            "field-order-date": "2026-08-19T10:00:00+08:00",
            "field-order-status": "Completed",
        },
    ),
    (
        "rec-order-002",
        "mod-orders",
        {
            "field-order-number": "SO-1002",
            "field-order-customer": "Maria Santos",
            "field-order-total": 850.0,
            "field-order-date": "2026-08-19T12:00:00+08:00",
            "field-order-status": "Pending",
        },
    ),
    (
        "rec-order-003",
        "mod-orders",
        {
            "field-order-number": "SO-1003",
            "field-order-customer": "Juan Dela Cruz",
            "field-order-total": 2100.0,
            "field-order-date": "2026-08-19T14:00:00+08:00",
            "field-order-status": "Completed",
        },
    ),
]


def sample_password() -> str:
    settings = get_settings()
    password = (
        os.environ.get("SAMPLE_USER_PASSWORD")
        or os.environ.get("ADMIN_BOOTSTRAP_PASSWORD")
        or (
            settings.sample_user_password.get_secret_value()
            if settings.sample_user_password is not None
            else None
        )
        or (
            settings.admin_bootstrap_password.get_secret_value()
            if settings.admin_bootstrap_password is not None
            else None
        )
    )
    if not password or len(password) < 12:
        raise SystemExit(
            "Set SAMPLE_USER_PASSWORD or ADMIN_BOOTSTRAP_PASSWORD to a password of at least "
            "12 characters"
        )
    return password


class ApiClient:
    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        payload: Mapping[str, Any] | None = None,
        query: Mapping[str, str | int] | None = None,
    ) -> dict[str, Any] | None:
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urlencode(query)}"
        headers = {"Accept": "application/json"}
        if self.token is not None:
            headers["Authorization"] = f"Bearer {self.token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode()
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with urlopen(request) as response:
                body = response.read()
        except HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise RuntimeError(f"{method} {path} failed ({error.code}): {detail}") from error
        except URLError as error:
            raise RuntimeError(f"Unable to reach API at {self.base_url}: {error.reason}") from error
        return json.loads(body) if body else None

    def login(self, username: str, password: str) -> str:
        response = self.request(
            "POST", "/api/auth/login", {"username": username, "password": password}
        )
        if response is None or "access_token" not in response:
            raise RuntimeError("Login response did not contain an access token")
        return str(response["access_token"])


def admin_credentials() -> tuple[str, str]:
    settings = get_settings()
    username = settings.admin_bootstrap_username
    password = (
        settings.admin_bootstrap_password.get_secret_value()
        if settings.admin_bootstrap_password is not None
        else None
    )
    if not username or not password:
        raise SystemExit("ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD must be configured")
    return username, password


def main() -> None:
    password = sample_password()
    admin_username, admin_password = admin_credentials()
    client = ApiClient(os.environ.get("API_BASE_URL", "http://localhost:8000"))
    client.token = client.login(admin_username, admin_password)

    existing_users = client.request("GET", "/api/users", query={"limit": 100}) or {}
    existing_names = {item["username"] for item in existing_users.get("items", [])}
    if existing_names.intersection({"admin", "maria", "jose"}):
        raise SystemExit("Sample users already exist; run clear_database before reseeding")

    roles_response = client.request("GET", "/api/roles", query={"limit": 100}) or {}
    role_ids = {item["role"].lower(): item["id"] for item in roles_response.get("items", [])}
    if "admin" not in role_ids:
        raise RuntimeError("The seeded admin role is missing")
    client.request(
        "PATCH",
        f"/api/roles/{role_ids['admin']}",
        {"permissions": ROLE_SPECS["admin"]},
    )
    for role_name in ("manager", "staff"):
        if role_name not in role_ids:
            role = client.request(
                "POST",
                "/api/roles",
                {"role": role_name, "permissions": ROLE_SPECS[role_name]},
            )
            if role is None:
                raise RuntimeError(f"Role creation returned no response: {role_name}")
            role_ids[role_name] = role["id"]

    user_ids: dict[str, str] = {}
    for username, role_name in (("admin", "admin"), ("maria", "manager"), ("jose", "staff")):
        user = client.request(
            "POST",
            "/api/users",
            {"username": username, "password": password, "role_id": role_ids[role_name]},
        )
        if user is None:
            raise RuntimeError(f"User creation returned no response: {username}")
        user_ids[username] = user["id"]

    # Use the generated sample admin as the actor for the remaining API writes.
    client.token = client.login("admin", password)

    department_ids: dict[str, str] = {}
    for logical_id, name in DEPARTMENT_SPECS.items():
        department = client.request("POST", "/api/departments", {"department_name": name})
        if department is None:
            raise RuntimeError(f"Department creation returned no response: {name}")
        department_ids[logical_id] = department["id"]

    module_ids: dict[str, str] = {}
    for logical_id, (department_id, name) in MODULE_SPECS.items():
        module = client.request(
            "POST",
            "/api/modules",
            {"department_id": department_ids[department_id], "module_name": name},
        )
        if module is None:
            raise RuntimeError(f"Module creation returned no response: {name}")
        module_ids[logical_id] = module["id"]

    field_ids: dict[str, str] = {}
    for logical_id, module_id, name, field_type, required, position, config in FIELD_SPECS:
        field = client.request(
            "POST",
            "/api/fields",
            {
                "module_id": module_ids[module_id],
                "name": name,
                "type": field_type,
                "required": required,
                "position": position,
                "config": config,
            },
        )
        if field is None:
            raise RuntimeError(f"Field creation returned no response: {name}")
        field_ids[logical_id] = field["id"]

    record_ids: dict[str, str] = {}
    record_responses: dict[str, dict[str, Any]] = {}
    for logical_id, module_id, data in RECORD_SPECS:
        record = client.request(
            "POST",
            "/api/records",
            {
                "module_id": module_ids[module_id],
                "data": {field_ids[key]: value for key, value in data.items()},
            },
        )
        if record is None:
            raise RuntimeError(f"Record creation returned no response: {logical_id}")
        record_ids[logical_id] = record["id"]
        record_responses[logical_id] = record

    # The API has no audit-create endpoint. This PATCH creates the sample update audit entry.
    sample_record = record_responses["rec-001"]
    updated_data = dict(sample_record["data"])
    updated_data[field_ids["field-prod-stock"]] = 18
    client.request("PATCH", f"/api/records/{record_ids['rec-001']}", {"data": updated_data})
    print("Sample data seeded through the API with generated UUIDs")


if __name__ == "__main__":
    main()
