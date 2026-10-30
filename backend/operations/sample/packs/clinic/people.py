"""Clinic identities and their Access group grants (minimum-necessary, module by module)."""

from __future__ import annotations

from operations.sample.packs.types import PersonSpec

INTERNAL_DOMAIN = "clinic.example"
GUEST_DOMAINS = ("lakeside-survey.example", "northline-biomed.example")

DEPARTMENT_KEYS = (
    "patient_access",
    "clinical",
    "laboratory",
    "pharmacy",
    "revenue_cycle",
    "operations",
    "quality",
)

TEAM_GROUPS = {
    "patient_access": "front-desk",
    "clinical": "clinicians",
    "laboratory": "laboratory-team",
    "pharmacy": "pharmacy-team",
    "revenue_cycle": "revenue-cycle",
    "operations": "operations-supply",
    "quality": "quality-office",
}

TEAM_ROSTER: dict[str, tuple[str, ...]] = {
    "patient_access": ("Renata Okafor", "Dylan Mercer", "Priya Natarajan", "Marcus Tillman"),
    "clinical": ("Helena Brandt", "Samuel Achebe", "Corinne Waller", "Tomas Reyna"),
    "laboratory": ("Ingrid Solberg", "Jamal Whitfield", "Lucia Ferraro"),
    "pharmacy": ("Nadia Kowalczyk", "Elliot Fairbanks", "Rosa Delgado"),
    "revenue_cycle": ("Gregory Lindahl", "Monique Easton", "Kevin Ostrowski", "Tessa Marlowe"),
    "operations": ("Victor Albright", "Hannah Szabo", "Desmond Pryor"),
    "quality": ("Margaret Quinlan", "Owen Castellanos", "Farah Siddiqui"),
}

TEAM_TITLES: dict[str, tuple[str, ...]] = {
    "patient_access": (
        "Front Office Supervisor",
        "Patient Service Representative",
        "Patient Service Representative",
        "Call Center Agent",
    ),
    "clinical": ("Medical Director", "Family Physician", "Charge Nurse", "Medical Assistant"),
    "laboratory": ("Laboratory Manager", "Medical Technologist", "Phlebotomist"),
    "pharmacy": ("Pharmacist-in-Charge", "Staff Pharmacist", "Pharmacy Technician"),
    "revenue_cycle": ("Billing Manager", "Medical Coder", "Claims Specialist", "Payment Poster"),
    "operations": ("Operations Manager", "Purchasing Officer", "Storekeeper"),
    "quality": (
        "Quality and Compliance Officer",
        "Credentialing Specialist",
        "Infection Prevention Nurse",
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


# Each team writes its own department and reads only the records its work names in
# another department (plan rule 11). Encounters, lab results and prescriptions stay
# closed to the front desk, revenue reads encounters only, and no patient module is open
# to operations or quality (plan rule 8).
GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "front-desk": (("patient_access", None, "write"),),
    "front-desk-leads": (("patient_access", None, "manage"),),
    "clinicians": (
        ("clinical", None, "write"),
        *_rows("patient_access", ("patients", "coverages", "appointments"), "read"),
        *_rows("laboratory", ("specimens", "lab_results"), "read"),
        ("pharmacy", "dispenses", "read"),
        ("operations", "purchase_requests", "write"),
    ),
    "clinical-leads": (("clinical", None, "manage"),),
    "laboratory-team": (
        ("laboratory", None, "write"),
        ("laboratory", "lab_qc_runs", "manage"),
        ("clinical", "orders", "read"),
        ("patient_access", "patients", "read"),
        ("operations", "equipment", "read"),
    ),
    "laboratory-leads": (("laboratory", None, "manage"),),
    "pharmacy-team": (
        ("pharmacy", None, "write"),
        ("clinical", "prescriptions", "read"),
        ("patient_access", "patients", "read"),
        ("laboratory", "lab_results", "read"),
        ("operations", "equipment", "read"),
        ("operations", "purchase_requests", "write"),
    ),
    "pharmacy-leads": (("pharmacy", None, "manage"),),
    "revenue-cycle": (
        ("revenue_cycle", None, "write"),
        ("clinical", "encounters", "read"),
        ("patient_access", "patients", "read"),
        ("patient_access", "coverages", "write"),
        ("patient_access", "payers", "read"),
    ),
    "revenue-leads": (("revenue_cycle", None, "manage"),),
    "operations-supply": (
        ("operations", None, "write"),
        ("pharmacy", "temperature_logs", "read"),
    ),
    "operations-leads": (("operations", None, "manage"),),
    "quality-office": (
        ("quality", None, "write"),
        *_rows("operations", ("equipment", "maintenance_work_orders"), "read"),
        ("pharmacy", "temperature_logs", "read"),
    ),
    "quality-leads": (("quality", None, "manage"),),
    # Project Boards use this shared membership group; it grants no data access.
    "clinic-staff": (),
    "survey-guests": (("quality", "staff_credentials", "read"),),
    "biomed-contractors": _rows("operations", ("equipment", "maintenance_work_orders"), "read"),
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
    "patient_access": "front-desk-leads",
    "clinical": "clinical-leads",
    "laboratory": "laboratory-leads",
    "pharmacy": "pharmacy-leads",
    "revenue_cycle": "revenue-leads",
    "operations": "operations-leads",
    "quality": "quality-leads",
}

FRONT_DESK_KEY = "internal_patient_access_03"
NURSE_KEY = "internal_clinical_03"
# Team members by role, in the roster order above.
CLAIMS_SPECIALIST_KEY = TEAM_KEYS["revenue_cycle"][2]
PAYMENT_POSTER_KEY = TEAM_KEYS["revenue_cycle"][3]
STOREKEEPER_KEY = "internal_operations_03"
GUEST_SURVEYOR_KEY = "guest_surveyor"
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
            groups = [TEAM_GROUPS[department], "clinic-staff"]
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
        status="active", groups=(group,), sponsor="internal_quality_lead",
    )  # fmt: skip


PEOPLE = (
    *_active_people(),
    _member(PENDING_KEY, "Jasmine Holt", "Patient Service Representative", ("front-desk",),
            status="pending"),  # fmt: skip
    _member(DISABLED_KEY, "Caleb Norris", "Medical Assistant", ("clinicians",),
            status="disabled"),  # fmt: skip
    _guest(GUEST_SURVEYOR_KEY, "Beatrice Collier", "Accreditation Surveyor", GUEST_DOMAINS[0],
           "survey-guests"),  # fmt: skip
    _guest("guest_biomed", "Rafael Ibarra", "Biomedical Technician", GUEST_DOMAINS[1],
           "biomed-contractors"),  # fmt: skip
)
