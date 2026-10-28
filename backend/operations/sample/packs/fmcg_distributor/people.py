"""Distributor identities and their Access group grants (research §11, plan rule 11)."""

from __future__ import annotations

from operations.sample.packs.types import PersonSpec

INTERNAL_DOMAIN = "silangan-distributors.example"
GUEST_DOMAINS = ("kestrel-dairy.example", "fajardo-audit.example")

DEPARTMENT_KEYS = (
    "sales",
    "trade_marketing",
    "purchasing",
    "warehouse",
    "logistics",
    "credit_collections",
    "accounting",
)

TEAM_GROUPS = {
    "sales": "sales-team",
    "trade_marketing": "trade-marketing",
    "purchasing": "purchasing-team",
    "warehouse": "warehouse-team",
    "logistics": "logistics-team",
    "credit_collections": "credit-team",
    "accounting": "accounting-team",
}

# Writers per department stay at four or fewer, so one or two people carry most work.
TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "sales": ("Ramon Dizon", "Cristina Abuel", "Mylene Sarmiento", "Arnel Cabrera"),
    "trade_marketing": ("Patricia Gatchalian", "Joel Tamayo", "Kristine Ocampo"),
    "purchasing": ("Ernesto Valdez", "Grace Lacsamana", "Bryan Quiambao"),
    "warehouse": ("Danilo Pascual", "Rowena Ilagan", "Jomar Santos", "Edlyn Mercado"),
    "logistics": ("Rogelio Aquino", "Mae Dimaculangan", "Nestor Bernardo"),
    "credit_collections": ("Teresita Galang", "Paolo Reyes", "Junrey Manalo", "Analyn Torres"),
    "accounting": ("Victoria Lim", "Marvin Soriano", "Hazel Navarro"),
}

TEAM_TITLES: dict[str, tuple[str, ...]] = {
    "sales": ("Sales Manager", "Area Sales Supervisor", "Pre-seller", "Van Salesman"),
    "trade_marketing": (
        "Key Accounts and Trade Marketing Manager",
        "Key Account Executive",
        "Trade Marketing Officer",
    ),
    "purchasing": ("Purchasing Manager", "Purchasing Officer", "Master Data Assistant"),
    "warehouse": (
        "Warehouse Manager",
        "Inventory Controller",
        "Receiving Checker",
        "Returns (BO) Clerk",
    ),
    "logistics": ("Logistics Supervisor", "Dispatcher", "Driver"),
    "credit_collections": (
        "Credit and Collections Manager",
        "Credit Analyst",
        "Collector",
        "Cashier",
    ),
    "accounting": ("Finance Controller", "AP Accountant", "Claims Officer"),
}

TEAM_KEYS = {
    department: (
        f"internal_{department}_lead",
        *(
            f"internal_{department}_{index:02d}"
            for index in range(2, len(TEAM_ROSTER[department]) + 1)
        ),
    )
    for department in TEAM_ROSTER
}


def _rows(
    department: str, modules: tuple[str, ...], level: str
) -> tuple[tuple[str, str | None, str], ...]:
    return tuple((department, module, level) for module in modules)


# Each team writes its own department and reads only the records its work names in another
# department (plan rule 11). Cash custody stays apart from receivables: sales reads invoices
# and receipts but cannot change them, and drivers cannot see Credit and Collections at all.
GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "sales-team": (
        ("sales", None, "write"),
        *_rows("purchasing", ("products",), "read"),
        *_rows("logistics", ("vehicles",), "read"),
        *_rows("trade_marketing", ("trade_promotions",), "read"),
        *_rows("credit_collections", ("sales_invoices", "collection_receipts", "credit_reviews"),
               "read"),  # fmt: skip
        *_rows("warehouse", ("returns",), "read"),
    ),
    "sales-leads": (("sales", None, "manage"),),
    "trade-marketing": (
        ("trade_marketing", None, "write"),
        ("sales", None, "read"),
        *_rows("purchasing", ("principals", "products"), "read"),
        *_rows("accounting", ("principal_claims",), "read"),
    ),
    "trade-marketing-leads": (("trade_marketing", None, "manage"),),
    "purchasing-team": (
        ("purchasing", None, "write"),
        *_rows("warehouse", ("goods_receipts", "stock_lots"), "read"),
        *_rows("accounting", ("principal_invoices",), "read"),
    ),
    "purchasing-leads": (("purchasing", None, "manage"),),
    "warehouse-team": (
        ("warehouse", None, "write"),
        *_rows("purchasing", ("products", "purchase_orders"), "read"),
        *_rows("sales", ("outlets", "sales_orders"), "read"),
        *_rows("credit_collections", ("sales_invoices",), "read"),
    ),
    "warehouse-leads": (("warehouse", None, "manage"),),
    "logistics-team": (
        ("logistics", None, "write"),
        *_rows("sales", ("sales_orders",), "read"),
    ),
    "logistics-leads": (("logistics", None, "manage"),),
    "credit-team": (
        ("credit_collections", None, "write"),
        ("sales", None, "read"),
    ),
    "credit-leads": (("credit_collections", None, "manage"),),
    "accounting-team": (
        ("accounting", None, "write"),
        ("purchasing", None, "read"),
        ("trade_marketing", None, "read"),
        ("warehouse", None, "read"),
        ("credit_collections", None, "read"),
        ("sales", None, "read"),
    ),
    "accounting-leads": (("accounting", None, "manage"),),
    # Project Boards use this shared membership group; it grants no data access.
    "distributor-staff": (),
    # A principal sees its schemes and the SKU list; every principal's claims stay hidden,
    # because a guest reads every row of a module (research §11).
    "principal-reps": (
        ("trade_marketing", "trade_promotions", "read"),
        ("purchasing", "products", "read"),
    ),
    "auditors": (
        ("accounting", None, "read"),
        ("credit_collections", None, "read"),
    ),
}

MODULE_KEYS = tuple(
    dict.fromkeys(
        module
        for rows in GROUP_ACCESS.values()
        for _department, module, _level in rows
        if module is not None
    )
)

_LEADER_GROUPS = {
    "sales": "sales-leads",
    "trade_marketing": "trade-marketing-leads",
    "purchasing": "purchasing-leads",
    "warehouse": "warehouse-leads",
    "logistics": "logistics-leads",
    "credit_collections": "credit-leads",
    "accounting": "accounting-leads",
}

# Team members by role, in the roster order above.
SUPERVISOR_KEY = TEAM_KEYS["sales"][1]
PRE_SELLER_KEY = TEAM_KEYS["sales"][2]
VAN_SALESMAN_KEY = TEAM_KEYS["sales"][3]
KEY_ACCOUNT_KEY = TEAM_KEYS["trade_marketing"][1]
PURCHASING_OFFICER_KEY = TEAM_KEYS["purchasing"][1]
INVENTORY_CONTROLLER_KEY = TEAM_KEYS["warehouse"][1]
RECEIVING_CHECKER_KEY = TEAM_KEYS["warehouse"][2]
BO_CLERK_KEY = TEAM_KEYS["warehouse"][3]
DRIVER_KEY = TEAM_KEYS["logistics"][2]
CREDIT_ANALYST_KEY = TEAM_KEYS["credit_collections"][1]
COLLECTOR_KEY = TEAM_KEYS["credit_collections"][2]
CASHIER_KEY = TEAM_KEYS["credit_collections"][3]
FINANCE_CONTROLLER_KEY = TEAM_KEYS["accounting"][0]
CLAIMS_OFFICER_KEY = TEAM_KEYS["accounting"][2]
GUEST_PRINCIPAL_KEY = "guest_principal"
GUEST_AUDITOR_KEY = "guest_auditor"
PENDING_KEY = "internal_pending_01"
DISABLED_KEY = "internal_disabled_01"


def _email(name: str, domain: str) -> tuple[str, str]:
    first, last = name.lower().split()
    return f"{first}.{last}@{domain}", f"{first}_{last}"


def _member(
    key: str,
    name: str,
    title: str,
    groups: tuple[str, ...],
    *,
    status: str = "active",
    actor: str | None = None,
) -> PersonSpec:
    email, username = _email(name, INTERNAL_DOMAIN)
    return PersonSpec(
        key=key, email=email, username=username, name=name, title=title, role="member",
        status=status, groups=groups, actor=actor,
    )  # fmt: skip


def _active_people() -> tuple[PersonSpec, ...]:
    people: list[PersonSpec] = []
    for department, names in TEAM_ROSTER.items():
        for index, (name, title, key) in enumerate(
            zip(names, TEAM_TITLES[department], TEAM_KEYS[department], strict=True)
        ):
            groups = [TEAM_GROUPS[department], "distributor-staff"]
            if index == 0:
                groups.append(_LEADER_GROUPS[department])
            people.append(
                _member(key, name, title, tuple(groups), actor=department if index == 0 else None)
            )
    return tuple(people)


def _guest(key: str, name: str, title: str, domain: str, group: str, sponsor: str) -> PersonSpec:
    email, username = _email(name, domain)
    return PersonSpec(
        key=key, email=email, username=username, name=name, title=title, role="guest",
        status="active", groups=(group,), sponsor=sponsor,
    )  # fmt: skip


PEOPLE = (
    *_active_people(),
    _member(PENDING_KEY, "Carlo Espiritu", "Pre-seller", ("sales-team",), status="pending"),
    _member(DISABLED_KEY, "Dennis Ramos", "Van Salesman", ("sales-team",), status="disabled"),
    _guest(GUEST_PRINCIPAL_KEY, "Aileen Castro", "Principal Account Manager", GUEST_DOMAINS[0],
           "principal-reps", "internal_trade_marketing_lead"),  # fmt: skip
    _guest(GUEST_AUDITOR_KEY, "Rodel Fajardo", "External Auditor", GUEST_DOMAINS[1], "auditors",
           "internal_accounting_lead"),  # fmt: skip
)
