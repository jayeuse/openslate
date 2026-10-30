"""Foundation identities and their Access group grants (need-to-know, module by module)."""

from __future__ import annotations

from operations.sample.packs.types import PersonSpec

INTERNAL_DOMAIN = "fairhaven.example"
GUEST_DOMAINS = ("lumen-audit.example", "northgate-foundation.example")

DEPARTMENT_KEYS = (
    "resource_mobilization",
    "grants_partnerships",
    "programs",
    "meal",
    "finance",
    "procurement",
    "volunteer_engagement",
    "executive_office",
)

TEAM_GROUPS = {
    "resource_mobilization": "rm-team",
    "grants_partnerships": "grants-team",
    "programs": "programs-team",
    "meal": "meal-team",
    "finance": "finance-team",
    "procurement": "procurement-team",
    "volunteer_engagement": "volunteer-team",
    "executive_office": "executive-team",
}

TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "resource_mobilization": ("Teresa Villanueva", "Paolo Magbanua", "Kristine Lacson",
                              "Ramon Dimaculangan"),  # fmt: skip
    "grants_partnerships": ("Angela Soriano", "Miguel Tolentino", "Liza Manalastas",
                            "Joel Panganiban"),  # fmt: skip
    "programs": ("Rosario Dimaano", "Carlo Bautista", "Jenny Cabrera", "Arnel Sison"),
    "meal": ("Felicity Ramos", "Dennis Ocampo", "Grace Alvarado"),
    "finance": ("Victoria Mercado", "Ronaldo Pascual", "Mae Fernandez", "Eduardo Lim"),
    "procurement": ("Benjamin Castillo", "Shiela Navarro", "Rodel Aquino"),
    "volunteer_engagement": ("Patricia Gonzaga", "Kevin Santiago"),
    "executive_office": ("Lourdes Abad", "Noel Esguerra", "Carmela Reyes"),
}

TEAM_TITLES: dict[str, tuple[str, ...]] = {
    "resource_mobilization": (
        "Head of Resource Mobilization",
        "Donor Relations Officer",
        "Gift Processing Associate",
        "Corporate Partnerships Officer",
    ),
    "grants_partnerships": (
        "Grants Manager",
        "Proposal Development Officer",
        "Grants Compliance Officer",
        "Partnerships Officer",
    ),
    "programs": (
        "Program Director",
        "Program Manager, Livelihood",
        "Project Officer",
        "Community Facilitator",
    ),
    "meal": ("MEAL Manager", "M&E Officer", "Information Management Officer"),
    "finance": ("Finance Manager", "Grants Accountant", "Disbursement Officer", "Cashier"),
    "procurement": (
        "Procurement and Logistics Lead",
        "Procurement Assistant",
        "Warehouse Assistant",
    ),
    "volunteer_engagement": ("Volunteer Coordinator", "Volunteer Engagement Associate"),
    "executive_office": (
        "Executive Director",
        "Accountability and Safeguarding Officer",
        "Executive Assistant and Board Secretary",
    ),
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
# department (plan rule 11). Safeguarding cases stay in the Executive Office (rule 8), and
# Resource Mobilization reads no beneficiary record.
GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "rm-team": (("resource_mobilization", None, "write"),),
    "rm-leads": (("resource_mobilization", None, "manage"),),
    "grants-team": (
        ("grants_partnerships", None, "write"),
        *_rows("meal", ("indicators", "indicator_results"), "read"),
    ),
    "grants-leads": (("grants_partnerships", None, "manage"),),
    "programs-team": (
        ("programs", None, "write"),
        *_rows("grants_partnerships", ("grant_awards", "budget_lines"), "read"),
        ("resource_mobilization", "donations", "read"),
        *_rows("finance", ("funds", "cash_advances"), "read"),
        ("procurement", "purchase_requests", "read"),
    ),
    "programs-leads": (("programs", None, "manage"),),
    "meal-team": (("meal", None, "write"), ("programs", None, "read")),
    "meal-leads": (("meal", None, "manage"),),
    "finance-team": (
        ("finance", None, "write"),
        ("grants_partnerships", None, "read"),
        ("procurement", None, "read"),
    ),
    "finance-leads": (("finance", None, "manage"),),
    "procurement-team": (
        ("procurement", None, "write"),
        ("grants_partnerships", "budget_lines", "read"),
    ),
    "procurement-leads": (("procurement", None, "manage"),),
    "volunteer-team": (("volunteer_engagement", None, "write"),),
    "volunteer-leads": (("volunteer_engagement", None, "manage"),),
    "executive-team": (("executive_office", None, "write"), ("programs", "projects", "read")),
    "executive-leads": (("executive_office", None, "manage"),),
    # Project Boards use this shared membership group; it grants no data access.
    "fcdf-staff": (),
    "audit-guests": (("finance", None, "read"), ("procurement", None, "read")),
    "funder-guests": _rows("meal", ("indicators", "indicator_results"), "read"),
}

MODULE_KEYS = tuple(
    dict.fromkeys(
        module
        for rows in GROUP_ACCESS.values()
        for _department, module, _level in rows
        if module is not None
    )
)

_LEADER_GROUPS = {department: group.replace("-team", "-leads")
                  for department, group in TEAM_GROUPS.items()}  # fmt: skip

# Team members by role, in the roster order above.
GIFT_PROCESSOR_KEY = TEAM_KEYS["resource_mobilization"][2]
PROGRAM_MANAGER_KEY = TEAM_KEYS["programs"][1]
PROJECT_OFFICER_KEY = TEAM_KEYS["programs"][2]
FACILITATOR_KEY = TEAM_KEYS["programs"][3]
PROCUREMENT_ASSISTANT_KEY = TEAM_KEYS["procurement"][1]
FUNDER_GUEST_KEY = "guest_funder"
AUDITOR_GUEST_KEY = "guest_auditor"
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
            groups = [TEAM_GROUPS[department], "fcdf-staff"]
            if index == 0:
                groups.append(_LEADER_GROUPS[department])
            people.append(
                _member(key, name, title, tuple(groups), actor=department if index == 0 else None)
            )
    return tuple(people)


def _guest(key: str, name: str, title: str, domain: str, group: str, sponsor: str
           ) -> PersonSpec:  # fmt: skip
    email, username = _email(name, domain)
    return PersonSpec(
        key=key, email=email, username=username, name=name, title=title, role="guest",
        status="active", groups=(group,), sponsor=sponsor,
    )  # fmt: skip


PEOPLE = (
    *_active_people(),
    _member(PENDING_KEY, "Janine Valdez", "Project Officer", ("programs-team",),
            status="pending"),  # fmt: skip
    _member(DISABLED_KEY, "Oscar Medina", "Cashier", ("finance-team",), status="disabled"),
    _guest(AUDITOR_GUEST_KEY, "Hannah Leung", "External Auditor", GUEST_DOMAINS[0],
           "audit-guests", "internal_finance_lead"),  # fmt: skip
    _guest(FUNDER_GUEST_KEY, "Daniel Arceo", "Grant Officer", GUEST_DOMAINS[1],
           "funder-guests", "internal_meal_lead"),  # fmt: skip
)

# People by role, for User fields: each one reads the module the field is on.
LEADS = {department: keys[0] for department, keys in TEAM_KEYS.items()}
