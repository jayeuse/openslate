"""Natural record text and reserved-domain identifiers for a UK school."""

from __future__ import annotations

import random
from collections.abc import Mapping

from operations.sample.packs.school import vocabulary
from operations.sample.packs.school.catalog_fields import TERMS, YEAR_GROUPS
from operations.sample.packs.school.links import student_index

_PREFIXES = {
    "admission_inquiries": "INQ-26-",
    "applications": "APP-26-",
    "students": "STU-",
    "attendance_exceptions": "ATT-26-",
    "courses": "CRS-",
    "class_sections": "SEC-",
    "assessments": "ASM-26-",
    "report_card_batches": "RCB-26-",
    "academic_alerts": "AAL-26-",
    "grade_change_requests": "GCR-26-",
    "behaviour_incidents": "INC-26-",
    "guidance_cases": "GDN-26-",
    "parent_contacts": "PCL-26-",
    "clinic_visits": "CLN-26-",
    "health_alerts": "HAL-26-",
    "fee_items": "FEE-",
    "fee_assessments": "SOA-2627-",
    "payments": "RCPT-26-",
    "fee_adjustments": "ADJ-26-",
    "collection_cases": "COL-26-",
    "rooms": "RM-",
    "maintenance_requests": "WO-26-",
    "activities": "ACT-",
    "staff_leave": "LV-26-",
}


def _person(index: int, seed: int) -> str:
    first = vocabulary.FIRST_NAMES[(index * 7 + seed) % len(vocabulary.FIRST_NAMES)]
    last = vocabulary.LAST_NAMES[(index * 13 + seed // 3) % len(vocabulary.LAST_NAMES)]
    return f"{first} {last}"


def person_name(module_key: str, index: int, seed: int) -> str:
    """Keep the enrolled application's child name on the resulting pupil entry."""
    if module_key in {"admission_inquiries", "applications"} and index == 4:
        index = 0
    return _person(index, seed)


def reference_code(module_key: str, index: int, _seed: int) -> str | None:
    prefix = _PREFIXES.get(module_key)
    if prefix is None:
        return None
    if module_key == "students":
        return f"{2010 + index % 15}-{index + 1:04d}"
    if module_key == "courses":
        subject = vocabulary.COURSE_CODES[index % len(vocabulary.COURSE_CODES)]
        return f"{subject}{YEAR_GROUPS[(index % 13) + 1].removeprefix('Year ')}"
    if module_key == "class_sections":
        year = YEAR_GROUPS[(index % 13) + 1].removeprefix("Year ")
        form = vocabulary.FORM_NAMES[index % len(vocabulary.FORM_NAMES)]
        return f"Y{year}-{form[:2].upper()}-{index + 1:03d}"
    if module_key == "fee_items":
        return f"{prefix}{index + 1:03d}"
    return f"{prefix}{index + 1:06d}"


def customer_name(index: int, seed: int) -> str:
    return f"{_person(index, seed)} family"


def supplier_name(index: int) -> str:
    names = (
        "Northmere Learning Supplies",
        "Ashcombe Schoolwear",
        "Westfield Books and Stationery",
        "Cedar Grove Catering",
        "Brookfield Music Services",
        "Meadowgate Science Stores",
        "Wrenford Sports Equipment",
        "Highcroft Classroom Resources",
    )
    return (
        f"{names[index % len(names)]} {index // len(names) + 1}"
        if index >= len(names)
        else names[index]
    )


def equipment_name(index: int) -> str:
    items = ("Boiler plant", "Library lift", "Sports-hall divider", "Kiln", "Stage lighting rig")
    return f"{items[index % len(items)]} {index // len(items) + 1:02d}"


def product_name(index: int, seed: int) -> str:
    items = ("A4 exercise books", "Whiteboard pens", "Watercolour set", "Football", "Lab goggles")
    return f"{items[(index + seed) % len(items)]}, pack {index // len(items) + 1:03d}"


def warehouse_name(index: int, seed: int) -> str:
    stores = ("Ground-floor stationery store", "Science preparation room", "Sports equipment store")
    return f"{stores[(index + seed) % len(stores)]} {index // len(stores) + 1}"


def site_place(index: int, seed: int) -> str:
    places = ("Northmere", "Ashcombe", "Westfield", "Brookfield", "Meadowgate", "Wrenford")
    return places[(index * 3 + seed) % len(places)]


def site_name(index: int, seed: int, _counts: Mapping[str, int]) -> str:
    return f"{site_place(index, seed)} School"


def record_title(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    person = person_name(module_key, index, seed)
    student = reference_code("students", student_index(module_key, index, counts), seed) or "Pupil"
    year_group = YEAR_GROUPS[(index * 5 + seed) % len(YEAR_GROUPS)]
    term = TERMS[(index + seed) % len(TERMS)]
    if module_key in {"admission_inquiries", "applications"}:
        year_group = YEAR_GROUPS[(index * 7 + seed) % len(YEAR_GROUPS)]
    if module_key == "admission_inquiries":
        return f"{person} — {year_group} enquiry"
    if module_key == "applications":
        return f"{person} — {year_group} application"
    if module_key == "students":
        return f"{year_group} — {person}"
    if module_key == "attendance_exceptions":
        return f"{student} — attendance exception {index + 1:06d}"
    if module_key == "courses":
        code = reference_code(module_key, index, seed)
        return f"{vocabulary.SUBJECTS[index % len(vocabulary.SUBJECTS)]} — {code}"
    if module_key == "class_sections":
        form = vocabulary.FORM_NAMES[index % len(vocabulary.FORM_NAMES)]
        return f"{year_group} {form} — {index % 7 + 1}"
    if module_key == "assessments":
        title = vocabulary.ASSESSMENT_TITLES[index % len(vocabulary.ASSESSMENT_TITLES)]
        subject = vocabulary.SUBJECTS[index % len(vocabulary.SUBJECTS)]
        return f"{year_group} {subject} — {title} {index + 1:03d}"
    if module_key == "report_card_batches":
        return f"{year_group} form — {term} reporting batch {index + 1:02d}"
    if module_key == "academic_alerts":
        return f"{student} — progress review {index + 1:03d}"
    if module_key == "grade_change_requests":
        return f"{student} — mark amendment {index + 1:03d}"
    if module_key == "behaviour_incidents":
        return f"{student} — pastoral incident {index + 1:03d}"
    if module_key == "guidance_cases":
        return f"{student} — pastoral case {index + 1:03d}"
    if module_key == "parent_contacts":
        return f"{student} — family contact {index + 1:03d}"
    if module_key == "clinic_visits":
        return f"{student} — medical-room visit {index + 1:03d}"
    if module_key == "health_alerts":
        return f"{student} — care information review {index + 1:03d}"
    if module_key == "fee_items":
        return f"{vocabulary.FEE_ITEMS[index % len(vocabulary.FEE_ITEMS)]} — {index + 1:03d}"
    if module_key == "fee_assessments":
        return f"{student} — {term} statement {index + 1:04d}"
    if module_key == "payments":
        return f"Family payment — receipt {index + 1:06d}"
    if module_key == "fee_adjustments":
        return f"{student} — bursary review {index + 1:03d}"
    if module_key == "collection_cases":
        return f"{student} — account follow-up {index + 1:03d}"
    if module_key == "rooms":
        room_type = ("classroom", "laboratory", "music room", "office")[index % 4]
        return f"{site_place(index, seed)} {room_type} {index + 1:03d}"
    if module_key == "maintenance_requests":
        return f"{site_place(index, seed)} site maintenance {index + 1:04d}"
    if module_key == "activities":
        activity = ("Choir", "Netball", "Debating", "Orchestra", "Community gardening")[index % 5]
        return f"{activity} group {index + 1:02d}"
    if module_key == "staff_leave":
        return f"{_person(index + 31, seed)} — leave request {index + 1:03d}"
    return f"School record {index + 1:04d}"


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    rng = random.Random(f"{seed}:{module_key}:{field_key}:{index}:school-note")
    if module_key == "attendance_exceptions":
        return vocabulary.ATTENDANCE_NOTES[(index * 3 + seed) % len(vocabulary.ATTENDANCE_NOTES)]
    if module_key == "behaviour_incidents":
        return vocabulary.INCIDENT_NOTES[(index + seed) % len(vocabulary.INCIDENT_NOTES)]
    if module_key == "clinic_visits":
        return vocabulary.HEALTH_NOTES[(index + seed) % len(vocabulary.HEALTH_NOTES)]
    if module_key == "maintenance_requests":
        return vocabulary.MAINTENANCE_NOTES[(index + seed) % len(vocabulary.MAINTENANCE_NOTES)]
    if module_key in {"parent_contacts", "guidance_cases", "academic_alerts"}:
        return vocabulary.GUARDIAN_NOTES[(index + seed) % len(vocabulary.GUARDIAN_NOTES)]
    if module_key == "assessments":
        phrase = vocabulary.TRADE_PHRASES[index % len(vocabulary.TRADE_PHRASES)]
        return f"{phrase.title()} moderation complete; marks return to the subject lead by Friday."
    if module_key == "fee_assessments" and index == 0:
        return (
            "Autumn tuition statement; part payment recorded and the remaining balance is £2,600."
        )
    if module_key == "fee_assessments":
        return "Termly statement checked against the bursar's approved fee schedule."
    if module_key == "staff_leave":
        reason = vocabulary.LEAVE_REASONS[(index + seed) % len(vocabulary.LEAVE_REASONS)]
        return f"{reason}; cover discussed with the year lead."
    templates = (
        "Subject lead reviewed the term plan with the form tutor.",
        "Family meeting arranged through the school office.",
        "Caretaker confirmed the room is ready for the morning lesson.",
        "Registrar checked the pupil's enrolment documents.",
        "Bursar confirmed the payment reference against the statement.",
    )
    return templates[rng.randrange(len(templates))]


def email_value(module_key: str, index: int, seed: int, _counts: Mapping[str, int]) -> str:
    if module_key in {
        "students",
        "admission_inquiries",
        "applications",
        "attendance_exceptions",
        "academic_alerts",
        "grade_change_requests",
        "behaviour_incidents",
        "guidance_cases",
        "parent_contacts",
        "clinic_visits",
        "health_alerts",
        "fee_assessments",
        "fee_adjustments",
        "collection_cases",
    }:
        local = f"family{index + 1:04d}"
        return f"{local}@families.example"
    first, last = _person(index, seed).lower().split()
    return f"{first}.{last}@northmere-school.example"


def phone_value(index: int, seed: int) -> str:
    return f"+44 7700 9{(index * 13 + seed) % 10_000:04d} {index % 10:01d}"


def serial_value(index: int, _seed: int) -> str:
    return f"SCH-{index + 1:06d}"


def url_value(module_key: str, index: int, _seed: int) -> str:
    return f"https://northmere-school.example/{module_key.replace('_', '-')}/{index + 1:04d}"
