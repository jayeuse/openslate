"""City hall identities and their Access group grants (research §11, minimum necessary).

Finance is split on purpose: the assessor, collector and disbursing officer of the Treasury,
the budget officer and the accountant each write only the module of their own signature.
The civil registry is its own group inside the City Clerk's department (plan rule 8).
"""

from __future__ import annotations

from operations.sample.packs.types import PersonSpec

INTERNAL_DOMAIN = "dalisaycity.example"
GUEST_DOMAINS = ("regional-audit.example", "fire-district.example")

DEPARTMENT_KEYS = (
    "bplo",
    "building_official",
    "public_works",
    "treasury",
    "budget_accounting",
    "procurement",
    "city_clerk",
)

# The department-wide group of each office: its Board writers.
TEAM_GROUPS = {
    "bplo": "bplo-staff",
    "building_official": "obo-staff",
    "public_works": "public-works",
    "treasury": "treasury-staff",
    "budget_accounting": "budget-accounting-staff",
    "procurement": "gso-staff",
    "city_clerk": "clerk-staff",
}

TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "bplo": ("Rowena Dimaculangan", "Jerome Macaraeg", "Kristine Panganiban", "Noel Ilagan"),
    "building_official": (
        "Ramon Esguerra",
        "Liza Buenaventura",
        "Arnel Quiambao",
        "Grace Alcantara",
    ),  # fmt: skip
    "public_works": ("Danilo Ocampo", "Maricel Fajardo", "Rodel Galang", "Edwin Pascual"),
    "treasury": ("Cynthia Navarro", "Marlon Bernardo", "Joy Agustin", "Rolando Valdez"),
    "budget_accounting": (
        "Teresita Medina",
        "Benjamin Rosales",
        "Aileen Torres",
        "Carlo Javier",
    ),  # fmt: skip
    "procurement": ("Victor Mendoza", "Rhea Gonzaga", "Paolo Deguzman", "Lorna Yap"),
    "city_clerk": ("Josefina Salvador", "Rafael Mercado", "Hazel Lim", "Antonio Garcia"),
}

TEAM_TITLES: dict[str, tuple[str, ...]] = {
    "bplo": ("BPLO Chief", "Licensing Officer II", "Permit Evaluator", "Business Inspector"),
    "building_official": (
        "Building Official",
        "Plan Evaluator",
        "Building Inspector",
        "Assessment Officer",
    ),  # fmt: skip
    "public_works": ("City Engineer", "Action Center Officer", "Engineer II", "Foreman"),
    "treasury": (
        "City Treasurer",
        "Licensing and Assessment Clerk",
        "Revenue Collection Clerk",
        "Disbursing Officer",
    ),  # fmt: skip
    "budget_accounting": (
        "City Accountant",
        "City Budget Officer",
        "Accountant II",
        "Bookkeeper",
    ),  # fmt: skip
    "procurement": (
        "City General Services Officer",
        "BAC Secretariat Head",
        "Procurement Officer",
        "Supply and Property Officer",
    ),  # fmt: skip
    "city_clerk": (
        "City Clerk and Secretary to the Sanggunian",
        "Legislative Staff Officer",
        "Records Officer",
        "Registration Officer",
    ),  # fmt: skip
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

# Role groups beside the department group, by team position (lead first).
_ROLE_GROUPS: dict[str, tuple[tuple[str, ...], ...]] = {
    "treasury": (
        (),
        ("treasury-assessment",),
        ("treasury-collection",),
        ("treasury-disbursing",),
    ),  # fmt: skip
    "budget_accounting": (
        (),
        ("budget-office",),
        ("accounting-office",),
        ("accounting-office",),
    ),  # fmt: skip
    "city_clerk": ((), (), ("records-unit",), ("civil-registry",)),
}

GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "bplo-staff": (("bplo", None, "write"), ("treasury", "payment_orders", "read")),
    "bplo-leads": (("bplo", None, "manage"),),
    "obo-staff": (("building_official", None, "write"), ("treasury", "payment_orders", "read")),
    "obo-leads": (("building_official", None, "manage"),),
    "public-works": (
        ("public_works", None, "write"),
        ("procurement", "purchase_requests", "write"),
    ),  # fmt: skip
    "public-works-leads": (("public_works", None, "manage"),),
    # Treasury: everyone reads the office's books; each signature writes one module.
    "treasury-staff": (("treasury", None, "read"),),
    "treasury-assessment": (
        ("treasury", "payment_orders", "write"),
        ("bplo", "permit_applications", "read"),
        ("building_official", "building_permits", "read"),
    ),
    "treasury-collection": (
        ("treasury", "official_receipts", "write"),
        ("treasury", "deposit_reports", "write"),
    ),
    "treasury-disbursing": (
        ("treasury", "payment_releases", "write"),
        ("budget_accounting", "disbursement_vouchers", "read"),
    ),
    "treasury-leads": (
        ("treasury", None, "manage"),
        ("bplo", "permit_applications", "read"),
        ("building_official", "building_permits", "read"),
        ("budget_accounting", "disbursement_vouchers", "read"),
    ),
    "budget-accounting-staff": (("budget_accounting", None, "read"),),
    "budget-office": (
        ("budget_accounting", "appropriations", "write"),
        ("budget_accounting", "obligation_requests", "write"),
        ("procurement", "purchase_orders", "read"),
    ),
    "accounting-office": (
        ("budget_accounting", "disbursement_vouchers", "write"),
        ("treasury", None, "read"),
        ("procurement", "acceptance_reports", "read"),
    ),
    "budget-accounting-leads": (
        ("budget_accounting", None, "manage"),
        ("treasury", None, "read"),
        ("procurement", "purchase_orders", "read"),
        ("procurement", "acceptance_reports", "read"),
    ),
    "gso-staff": (("procurement", None, "write"),),
    "gso-leads": (("procurement", None, "manage"),),
    # The council secretariat writes communications and measures, never the registry.
    "clerk-staff": (
        ("city_clerk", "communications", "write"),
        ("city_clerk", "legislative_measures", "write"),
    ),
    "records-unit": (("city_clerk", "communications", "write"),),
    "civil-registry": (("city_clerk", "civil_registry", "write"),),
    "clerk-leads": (("city_clerk", None, "manage"),),
    # Project Boards use this shared membership group; it grants no data access.
    "city-hall-staff": (),
    "state-auditors": (
        ("treasury", None, "read"),
        ("budget_accounting", None, "read"),
        ("procurement", None, "read"),
    ),
    "fire-inspectors": (
        ("bplo", "business_inspections", "read"),
        ("building_official", "building_inspections", "read"),
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
    "bplo": "bplo-leads",
    "building_official": "obo-leads",
    "public_works": "public-works-leads",
    "treasury": "treasury-leads",
    "budget_accounting": "budget-accounting-leads",
    "procurement": "gso-leads",
    "city_clerk": "clerk-leads",
}

# Team members by role, in the roster order above.
LICENSING_OFFICER_KEY = TEAM_KEYS["bplo"][1]
ASSESSOR_KEY = TEAM_KEYS["treasury"][1]
COLLECTOR_KEY = TEAM_KEYS["treasury"][2]
DISBURSING_KEY = TEAM_KEYS["treasury"][3]
BUDGET_OFFICER_KEY = TEAM_KEYS["budget_accounting"][1]
ACCOUNTANT_KEY = TEAM_KEYS["budget_accounting"][2]
COUNCIL_CLERK_KEY = TEAM_KEYS["city_clerk"][1]
REGISTRAR_KEY = TEAM_KEYS["city_clerk"][3]
GUEST_AUDITOR_KEY = "guest_state_auditor"
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
            groups = [TEAM_GROUPS[department], *roles[index], "city-hall-staff"]
            if index == 0:
                groups.append(_LEADER_GROUPS[department])
            people.append(
                _member(key, name, title, tuple(groups), actor=department if index == 0 else None)
            )
    return tuple(people)


def _guest(key: str, name: str, title: str, domain: str, group: str) -> PersonSpec:
    email, username = _email(name, domain)
    return PersonSpec(
        key=key, email=email, username=username, name=name, title=title, role="guest",
        status="active", groups=(group,), sponsor="internal_budget_accounting_lead",
    )  # fmt: skip


PEOPLE = (
    *_active_people(),
    _member(
        PENDING_KEY, "Michelle Tan", "Licensing Officer I", ("bplo-staff",), status="pending"
    ),  # fmt: skip
    _member(
        DISABLED_KEY,
        "Ernesto Bautista",
        "Maintenance Crew Leader",
        ("public-works",),
        status="disabled",
    ),  # fmt: skip
    _guest(
        GUEST_AUDITOR_KEY,
        "Marilou Fernandez",
        "State Auditor III",
        GUEST_DOMAINS[0],
        "state-auditors",
    ),  # fmt: skip
    _guest(
        "guest_fire_inspector",
        "Joel Ramirez",
        "Fire Safety Inspector",
        GUEST_DOMAINS[1],
        "fire-inspectors",
    ),  # fmt: skip
)
