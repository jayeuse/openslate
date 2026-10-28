"""Plant identities and their Access group grants (research §11, minimum necessary).

Each separated duty is its own module boundary: QA releases finished lots, buyers place
purchase orders but only accounts payable touches supplier invoices, and the planner owns
production orders that the floor and customer service only read. The groups that write a
module that names a record in another department read that department's module (rule 11).
"""

from __future__ import annotations

from operations.sample.packs.types import PersonSpec

INTERNAL_DOMAIN = "tillmorefoods.example"
GUEST_DOMAINS = ("sqf-audits.example", "midstate-boiler.example")

DEPARTMENT_KEYS = (
    "sales",
    "planning",
    "warehouse",
    "manufacturing",
    "quality",
    "maintenance",
    "finance",
)

# The department-wide group of each team: its Board writers.
TEAM_GROUPS = {
    "sales": "sales-team",
    "planning": "planning-team",
    "warehouse": "warehouse-team",
    "manufacturing": "production-team",
    "quality": "quality-team",
    "maintenance": "maintenance-team",
    "finance": "finance-team",
}

TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "sales": ("Karen Holloway", "Marcus Delgado", "Jenna Whitfield", "Tyler Brandt"),
    "planning": ("Douglas Reiner", "Priya Raman", "Scott Kowalski", "Angela Moreno"),
    "warehouse": ("Ray Castellano", "Luis Ortega", "Brianna Sykes", "Dale Hutchins"),
    "manufacturing": ("Greg Lindqvist", "Tamika Rhodes", "Jose Villanueva", "Kyle Pruitt"),
    "quality": ("Monica Feld", "Andre Ellison", "Rachel Novak", "Samuel Okafor"),
    "maintenance": ("Bill Harrigan", "Nora Lindgren", "Curtis Bowman", "Hector Salas"),
    "finance": ("Elaine Prescott", "Derek Huang", "Lisa Carrington", "Omar Haddad"),
}

TEAM_TITLES: dict[str, tuple[str, ...]] = {
    "sales": ("Sales and Customer Service Manager", "Customer Service Representative",
              "Key Account Manager", "Private Label Coordinator"),
    "planning": ("Supply Chain Manager", "Production Planner and Scheduler", "Buyer",
                 "Materials Planner"),
    "warehouse": ("Warehouse Supervisor", "Receiver", "Shipping Clerk", "Inventory Controller"),
    "manufacturing": ("Production Manager", "Shift Supervisor", "Line Lead", "Filler Operator"),
    "quality": ("QA Manager", "QA Technician", "Food Safety Coordinator", "Product Developer"),
    "maintenance": ("Maintenance Manager", "Maintenance Planner", "Mechanic",
                    "Electrician and Controls Technician"),
    "finance": ("Controller", "Accounts Receivable Clerk", "Accounts Payable Clerk",
                "Credit and Collections Analyst"),
}  # fmt: skip

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

# Role groups beside the department group, by team position (lead first).
_ROLE_GROUPS: dict[str, tuple[tuple[str, ...], ...]] = {
    "manufacturing": (("production-supervisors",), ("production-supervisors",), (), ()),
    "finance": (("finance-ar",), ("finance-ar",), ("finance-ap",), ("finance-collections",)),
}

GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "sales-team": (
        ("sales", None, "write"),
        ("planning", "products", "read"),
        ("planning", "production_orders", "read"),
        ("quality", "finished_goods_lots", "read"),
        ("finance", "customer_invoices", "read"),
    ),
    "sales-leads": (("sales", None, "manage"),),
    "planning-team": (
        ("planning", None, "write"),
        ("sales", None, "read"),
        ("warehouse", None, "read"),
        ("manufacturing", "work_centers", "read"),
        ("finance", "supplier_invoices", "read"),
    ),
    "planning-leads": (("planning", None, "manage"),),
    "warehouse-team": (
        ("warehouse", None, "write"),
        ("sales", "sales_orders", "read"),
        ("planning", "purchase_orders", "read"),
        ("quality", "finished_goods_lots", "read"),
    ),
    "warehouse-leads": (("warehouse", None, "manage"),),
    # The floor writes its own records and reads the orders, lots and finished lots it uses.
    "production-team": (
        ("manufacturing", None, "write"),
        ("planning", "production_orders", "read"),
        ("warehouse", "material_lots", "read"),
        ("quality", "finished_goods_lots", "read"),
    ),
    "production-supervisors": (("quality", None, "read"),),
    "production-leads": (("manufacturing", None, "manage"),),
    # QA releases batches and material lots, and reads the operations it verifies.
    "quality-team": (
        ("quality", None, "write"),
        ("manufacturing", None, "read"),
        ("manufacturing", "batch_records", "write"),
        ("planning", None, "read"),
        ("warehouse", None, "read"),
        ("warehouse", "material_lots", "write"),
    ),
    "quality-leads": (("quality", None, "manage"),),
    "maintenance-team": (
        ("maintenance", None, "write"),
        ("manufacturing", "work_centers", "read"),
        ("manufacturing", "downtime_events", "read"),
    ),
    "maintenance-leads": (("maintenance", None, "manage"),),
    # Finance reads every other department; receivables and payables sign separately.
    "finance-team": (
        ("finance", None, "read"),
        ("sales", None, "read"),
        ("planning", None, "read"),
        ("warehouse", None, "read"),
        ("manufacturing", None, "read"),
        ("quality", None, "read"),
        ("maintenance", None, "read"),
    ),
    "finance-ar": (
        ("finance", "customer_invoices", "write"),
        ("finance", "customer_payments", "write"),
    ),
    "finance-collections": (("finance", "customer_payments", "write"),),
    "finance-ap": (("finance", "supplier_invoices", "write"),),
    "finance-leads": (("finance", None, "manage"),),
    # Project Boards use this shared membership group; it grants no data access.
    "plant-staff": (),
    "food-safety-auditors": (
        ("quality", "food_safety_logs", "read"),
        ("quality", "capas", "read"),
    ),
    "maintenance-contractors": (("maintenance", None, "read"),),
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
    "planning": "planning-leads",
    "warehouse": "warehouse-leads",
    "manufacturing": "production-leads",
    "quality": "quality-leads",
    "maintenance": "maintenance-leads",
    "finance": "finance-leads",
}

# Team members by role, in the roster order above.
CS_REP_KEY = TEAM_KEYS["sales"][1]
BUYER_KEY = TEAM_KEYS["planning"][2]
SHIFT_SUPERVISOR_KEY = TEAM_KEYS["manufacturing"][1]
FILLER_OPERATOR_KEY = TEAM_KEYS["manufacturing"][3]
QA_TECH_KEY = TEAM_KEYS["quality"][1]
AR_CLERK_KEY = TEAM_KEYS["finance"][1]
AP_CLERK_KEY = TEAM_KEYS["finance"][2]
GUEST_AUDITOR_KEY = "guest_food_safety_auditor"
GUEST_CONTRACTOR_KEY = "guest_boiler_contractor"
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
        roles = _ROLE_GROUPS.get(department, ((),) * len(names))
        for index, (name, title, key) in enumerate(
            zip(names, TEAM_TITLES[department], TEAM_KEYS[department], strict=True)
        ):
            groups = [TEAM_GROUPS[department], *roles[index], "plant-staff"]
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
    _member(PENDING_KEY, "Travis Mendez", "Receiver", ("warehouse-team",), status="pending"),
    _member(
        DISABLED_KEY, "Wendy Albrecht", "Sanitation Lead", ("production-team",),
        status="disabled",
    ),  # fmt: skip
    _guest(
        GUEST_AUDITOR_KEY, "Patricia Langford", "Food Safety Auditor", GUEST_DOMAINS[0],
        "food-safety-auditors", "internal_quality_lead",
    ),  # fmt: skip
    _guest(
        GUEST_CONTRACTOR_KEY, "Russell Becker", "Boiler and Refrigeration Technician",
        GUEST_DOMAINS[1], "maintenance-contractors", "internal_maintenance_lead",
    ),  # fmt: skip
)
