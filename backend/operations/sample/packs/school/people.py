"""School identities and their current Access group grants."""

from __future__ import annotations

from operations.sample.packs.types import PersonSpec

INTERNAL_DOMAIN = "school.example"
GUEST_DOMAINS = ("wrenfield-audit.example", "northbank-accreditation.example")

DEPARTMENT_KEYS = (
    "admissions",
    "academic",
    "student_affairs",
    "health",
    "finance",
    "facilities",
    "hr",
)

TEAM_GROUPS = {
    "admissions": "admissions-team",
    "academic": "academic-office",
    "student_affairs": "student-affairs-office",
    "health": "health-services",
    "finance": "finance-office",
    "facilities": "facilities-team",
    "hr": "hr-team",
}

TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "admissions": ("Eleanor Marsh", "Thomas Bell"),
    "academic": ("Imogen Clarke", "Oliver Bennett", "Hannah Walsh", "Daniel Foster"),
    "student_affairs": ("Martha Price", "Jacob Wright", "Aisha Khan", "Nathan Ellis"),
    "health": ("Sophie Murray", "Ruby Patel"),
    "finance": ("Robert Davies", "Amelia Cox", "Jack Harper", "Priya Shah"),
    "facilities": ("James Carter", "Leo Morgan"),
    "hr": ("Olivia Grant", "Grace Turner"),
}

TEAM_TITLES: dict[str, tuple[str, ...]] = {
    "admissions": ("Director of Admissions", "Admissions Officer"),
    "academic": ("Academic Dean", "Registrar", "Class Teacher", "Mathematics Teacher"),
    "student_affairs": (
        "Dean of Students",
        "Behaviour Officer",
        "Guidance Counsellor",
        "Safeguarding Counsellor",
    ),
    "health": ("Senior School Nurse", "School Nurse"),
    "finance": ("Finance Manager", "Accounts Receivable Clerk", "School Cashier", "Bursar"),
    "facilities": ("Facilities Manager", "Maintenance Coordinator"),
    "hr": ("Head of Human Resources", "HR Officer"),
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

_FINANCE_MODULES = (
    "fee_items",
    "fee_assessments",
    "payments",
    "fee_adjustments",
    "collection_cases",
)
_ACADEMIC_READ_MODULES = ("students", "courses", "class_sections", "report_card_batches")


def _rows(
    department: str, modules: tuple[str, ...], level: str
) -> tuple[tuple[str, str | None, str], ...]:
    return tuple((department, module, level) for module in modules)


GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "admissions-team": (("admissions", None, "write"),),
    "admissions-leaders": (("admissions", None, "manage"),),
    "academic-office": (
        ("academic", None, "write"),
        *_rows("academic", _ACADEMIC_READ_MODULES, "read"),
    ),
    "academic-leaders": (
        ("academic", None, "manage"),
        *_rows("academic", _ACADEMIC_READ_MODULES, "read"),
        # The dean links an attendance exception to the clinic visit that explains it.
        ("health", "clinic_visits", "read"),
    ),
    "academic-registrars": (
        *_rows("academic", _ACADEMIC_READ_MODULES, "manage"),
        # Registrars link students to their applications and class sections to rooms.
        ("admissions", "applications", "read"),
        ("facilities", "rooms", "read"),
    ),
    "student-affairs-office": (
        *_rows(
            "student_affairs", ("behaviour_incidents", "parent_contacts", "activities"), "write"
        ),
        *_rows("academic", ("students", "attendance_exceptions", "academic_alerts"), "read"),
        ("facilities", "rooms", "read"),
    ),
    "student-affairs-leaders": (
        ("student_affairs", None, "manage"),
        ("student_affairs", "guidance_cases", "read"),
    ),
    "guidance-counsellors": (("student_affairs", "guidance_cases", "manage"),),
    "health-services": (("health", None, "write"), ("academic", "students", "read")),
    "health-leaders": (("health", None, "manage"),),
    "finance-office": (
        ("finance", None, "write"),
        *_rows("finance", _FINANCE_MODULES, "read"),
    ),
    "finance-leaders": (
        ("finance", None, "manage"),
        *_rows("finance", _FINANCE_MODULES, "read"),
        ("academic", "students", "read"),
    ),
    "finance-accounts": (
        *_rows("finance", ("fee_items", "fee_assessments", "collection_cases"), "manage"),
        *_rows("finance", ("payments", "fee_adjustments"), "read"),
        ("academic", "students", "read"),
    ),
    "finance-cashiers": (
        ("finance", None, "write"),
        *_rows(
            "finance",
            ("fee_items", "fee_assessments", "fee_adjustments", "collection_cases"),
            "read",
        ),
        ("finance", "payments", "manage"),
    ),
    "finance-bursars": (
        ("finance", None, "manage"),
        *_rows("finance", ("fee_items", "fee_assessments", "payments", "collection_cases"), "read"),
        ("finance", "fee_adjustments", "manage"),
        ("academic", "students", "read"),
    ),
    "facilities-team": (("facilities", None, "write"),),
    "facilities-leaders": (("facilities", None, "manage"),),
    "hr-team": (("hr", None, "write"),),
    "hr-leaders": (("hr", None, "manage"),),
    # Project Boards use this shared membership group; it grants no data access.
    "school-staff": (),
    "guest-auditors": (("finance", None, "read"),),
    "visiting-accreditors": _rows("academic", ("courses", "class_sections"), "read"),
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
    "admissions": "admissions-leaders",
    "academic": "academic-leaders",
    "student_affairs": "student-affairs-leaders",
    "health": "health-leaders",
    "finance": "finance-leaders",
    "facilities": "facilities-leaders",
    "hr": "hr-leaders",
}

TEACHER_KEYS = ("internal_academic_03", "internal_academic_04")
CASHIER_KEY = "internal_finance_03"
BURSAR_KEY = "internal_finance_04"
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
        key=key,
        email=email,
        username=username,
        name=name,
        title=title,
        role="member",
        status=status,
        groups=groups,
        actor=actor,
    )


def _active_people() -> tuple[PersonSpec, ...]:
    people: list[PersonSpec] = []
    for department, names in TEAM_ROSTER.items():
        for index, (name, title, key) in enumerate(
            zip(names, TEAM_TITLES[department], TEAM_KEYS[department], strict=True)
        ):
            groups = [TEAM_GROUPS[department], "school-staff"]
            if index == 0:
                groups.append(_LEADER_GROUPS[department])
            if department == "academic" and index == 1:
                groups.append("academic-registrars")
            if department == "student_affairs" and index >= 2:
                groups.append("guidance-counsellors")
            if department == "finance" and index == 1:
                groups.append("finance-accounts")
            if department == "finance" and index == 2:
                groups.append("finance-cashiers")
            if department == "finance" and index == 3:
                groups.append("finance-bursars")
            people.append(
                _member(
                    key,
                    name,
                    title,
                    tuple(groups),
                    actor=department if index == 0 else None,
                )
            )
    return tuple(people)


def _guest(key: str, name: str, title: str, domain: str, group: str) -> PersonSpec:
    email, username = _email(name, domain)
    return PersonSpec(
        key=key,
        email=email,
        username=username,
        name=name,
        title=title,
        role="guest",
        status="active",
        groups=(group,),
        sponsor="internal_hr_lead",
    )


PEOPLE = (
    *_active_people(),
    _member(
        PENDING_KEY,
        "Megan Howard",
        "Admissions Officer",
        ("admissions-team",),
        status="pending",
    ),
    _member(
        DISABLED_KEY,
        "Finley Scott",
        "Class Teacher",
        ("academic-office",),
        status="disabled",
    ),
    _guest(
        GUEST_AUDITOR_KEY,
        "Lydia Campbell",
        "External Auditor",
        GUEST_DOMAINS[0],
        "guest-auditors",
    ),
    _guest(
        "guest_accreditor",
        "Peter Reid",
        "Visiting Accreditor",
        GUEST_DOMAINS[1],
        "visiting-accreditors",
    ),
)
