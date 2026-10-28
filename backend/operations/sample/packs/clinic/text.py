"""Natural clinic record text and reserved-domain identifiers (US outpatient clinic)."""

from __future__ import annotations

import random
from collections.abc import Mapping

from operations.sample.packs.clinic import links, vocabulary

_PREFIXES = {
    "patients": "", "coverages": "COV-", "appointments": "APT-", "encounters": "ENC-",
    "orders": "ORD-", "prescriptions": "RX-", "specimens": "L", "lab_results": "RPT-",
    "lab_qc_runs": "QC-", "dispenses": "DSP-", "pharmacy_items": "PH-", "stock_lots": "LOT-",
    "temperature_logs": "TMP-", "claims": "CLM-", "claim_responses": "ERA-",
    "payments": "RCPT-", "purchase_requests": "PR-", "purchase_orders": "PO-",
    "equipment": "EQ-", "maintenance_work_orders": "WO-", "incident_reports": "IR-",
    "staff_credentials": "CRD-",
}  # fmt: skip
_START = {"appointments": 30_017, "encounters": 18_443, "claims": 4_812, "orders": 7_205,
          "prescriptions": 9_312, "payments": 22_340, "purchase_requests": 311,
          "purchase_orders": 311, "incident_reports": 17}  # fmt: skip
_CHECK = "ABCDEFGHJKLMNPQRSTUVWXYZ"
_PACK_SIZES = ("30-count bottle", "90-count bottle", "unit-dose box of 100", "500-count bottle",
               "blister of 10", "case of 12")  # fmt: skip


def reference_code(module_key: str, index: int, _seed: int) -> str | None:
    prefix = _PREFIXES.get(module_key)
    if prefix is None:
        return None
    number = _START.get(module_key, 1) + index
    if module_key == "patients":
        digits = f"{104_827 + index * 37:07d}"
        return f"{digits}-{_CHECK[sum(map(int, digits)) % len(_CHECK)]}"
    if module_key == "specimens":
        return f"L{2_600_023 + index * 7:08d}"
    if module_key == "equipment":
        return f"EQ-{index + 1:04d}"
    if module_key in {"purchase_requests", "purchase_orders", "incident_reports"}:
        return f"{prefix}{number:04d}"
    return f"{prefix}{number:06d}"


def _name_index(patient: int) -> int:
    """A few patients were registered twice; the second chart repeats an earlier name."""
    if patient >= 2 * links.PINNED and random.Random(f"clinic:dup:{patient}").random() < 0.02:
        return patient - 7
    return patient


def patient_names(patient: int, seed: int) -> tuple[str, str]:
    firsts, lasts = vocabulary.FIRST_NAMES, vocabulary.LAST_NAMES
    # 7919 is prime, so each patient below len(firsts) * len(lasts) gets its own name.
    pair = (_name_index(patient) * 7_919 + seed) % (len(firsts) * len(lasts))
    return firsts[pair % len(firsts)], lasts[pair // len(firsts)]


def patient_name(patient: int, seed: int) -> str:
    return " ".join(patient_names(patient, seed))


def payer(index: int) -> tuple[str, str, str]:
    name, kind, code = vocabulary.PAYERS[index % len(vocabulary.PAYERS)]
    cycle = index // len(vocabulary.PAYERS)
    return (f"{name} — region {cycle + 1}" if cycle else name), kind, f"{code}{cycle or ''}"


def item(index: int) -> tuple[str, str, str, bool]:
    """Generic name, strength, form, cold chain."""
    return vocabulary.MEDICATIONS[index % len(vocabulary.MEDICATIONS)]


def item_name(index: int) -> str:
    generic, strength, form, _cold = item(index)
    size = _PACK_SIZES[(index // len(vocabulary.MEDICATIONS)) % len(_PACK_SIZES)]
    batch = index // (len(vocabulary.MEDICATIONS) * len(_PACK_SIZES))
    suffix = f", second source {batch + 1}" if batch else ""
    return f"{generic} {strength} {form.lower()}, {size}{suffix}"


def equipment_name(index: int, counts: Mapping[str, int] | None = None) -> str:
    sized = counts or {"temperature_logs": 256, "lab_qc_runs": 192}
    fridges = links.fridge_count(sized)
    analyzers = links.analyzer_count(sized)
    if index < fridges:
        kind = "Vaccine refrigerator" if index % 2 == 0 else "Pharmacy refrigerator"
        return f"{kind} {index + 1}"
    if index < fridges + analyzers:
        return f"Chemistry analyzer {index - fridges + 1}"
    rest = index - fridges - analyzers
    kind = vocabulary.EQUIPMENT[rest % len(vocabulary.EQUIPMENT)][0]
    return f"{kind} {rest // len(vocabulary.EQUIPMENT) + 1}"


def supplier_name(index: int) -> str:
    names = vocabulary.SUPPLIERS
    if index < len(names):
        return names[index]
    return f"{names[index % len(names)]} (branch {index // len(names) + 1})"


def _lab(order: int) -> tuple[str, str, str, str, str]:
    menu = vocabulary.LAB_MENU
    if order < links.PINNED:
        return menu[order % len(menu)]
    rng = random.Random(f"clinic:lab-menu:{order}")
    return rng.choices(menu, weights=[(rank + 1) ** -0.8 for rank in range(len(menu))])[0]


def lab_service(order: int) -> tuple[str, str, str, str, str]:
    """Service, analyte, units, reference range, specimen type of a lab order."""
    return _lab(order)


def order_service(order: int) -> str:
    category = links.order_category(order)
    if category == "Imaging":
        return vocabulary.IMAGING[order % len(vocabulary.IMAGING)]
    if category == "Procedure":
        return vocabulary.PROCEDURES[order % len(vocabulary.PROCEDURES)]
    return _lab(order)[0]


def record_title(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    """Titles a clinic's staff would type; linked names come from the same link rules."""
    sized = {**counts}
    if module_key == "patients":
        return patient_name(index, seed)
    if module_key == "coverages":
        patient = links.coverage_patient(index, sized)
        plan = vocabulary.PLAN_SUFFIXES[index % len(vocabulary.PLAN_SUFFIXES)]
        insurer = payer(links.coverage_payer(index, sized))[0]
        return f"{patient_name(patient, seed)} — {insurer} {plan}"
    if module_key == "payers":
        return payer(index)[0]
    if module_key == "appointments":
        patient = links.appointment_patient(index % sized["appointments"], sized)
        return f"{patient_name(patient, seed)} — {reference_code(module_key, index, seed)}"
    if module_key == "encounters":
        patient = links.encounter_patient(index % sized["encounters"], sized)
        return f"{patient_name(patient, seed)} — visit {reference_code(module_key, index, seed)}"
    if module_key == "orders":
        encounter = links.order_encounter(index % sized["orders"], sized)
        patient = links.encounter_patient(encounter, sized)
        return f"{order_service(index)} — {patient_name(patient, seed)}"
    if module_key == "prescriptions":
        encounter = links.prescription_encounter(index % sized["prescriptions"], sized)
        medicine = item(links.prescription_item(index % sized["prescriptions"], sized))
        patient = links.encounter_patient(encounter, sized)
        return f"{medicine[0]} {medicine[1]} — {patient_name(patient, seed)}"
    if module_key == "specimens":
        orders = links.specimen_orders(index, sized)
        return f"{lab_service(orders[0])[4]} — {reference_code(module_key, index, seed)}"
    if module_key == "lab_results":
        _specimen, order = links.result_slot(index, sized)
        patient = links.encounter_patient(links.order_encounter(order, sized), sized)
        return f"{lab_service(order)[0]} — {patient_name(patient, seed)}"
    if module_key == "lab_qc_runs":
        analyzer = equipment_name(links.qc_analyzer(index, sized), sized)
        return f"{analyzer} — level {index % 3 + 1} QC {reference_code(module_key, index, seed)}"
    if module_key == "dispenses":
        prescription = links.dispense_prescription(index % sized["dispenses"], sized)
        medicine = item(links.prescription_item(prescription, sized))
        encounter = links.prescription_encounter(prescription, sized)
        patient = links.encounter_patient(encounter, sized)
        return f"{medicine[0]} {medicine[1]} fill — {patient_name(patient, seed)}"
    if module_key == "pharmacy_items":
        return item_name(index)
    if module_key == "stock_lots":
        return f"{item_name(links.lot_item(index, sized))} — lot {lot_number(index)}"
    if module_key == "temperature_logs":
        fridge = equipment_name(links.log_fridge(index, sized), sized)
        shift = ("AM", "PM")[index % 2]
        return f"{fridge} — {shift} check {reference_code(module_key, index, seed)}"
    if module_key == "claims":
        patient = links.claim_patient(index % sized["claims"], sized)
        return f"{reference_code(module_key, index, seed)} — {patient_name(patient, seed)}"
    if module_key == "claim_responses":
        claim = links.response_claim(index % sized["claim_responses"], sized)
        own, billed = reference_code(module_key, index, seed), reference_code("claims", claim, seed)
        return f"Remittance {own} for {billed}"
    if module_key == "payments":
        payment = index % sized["payments"]
        remitted = links.payment_claim(payment, sized)
        if remitted is not None:
            return f"Payer EFT — {reference_code('claims', remitted, seed)}"
        return f"Patient payment — {patient_name(links.payment_patient(payment, sized), seed)}"
    if module_key == "suppliers":
        return supplier_name(index)
    if module_key == "purchase_requests":
        supply = vocabulary.SUPPLY_ITEMS[(index * 5 + seed) % len(vocabulary.SUPPLY_ITEMS)]
        return f"{supply} — {reference_code(module_key, index, seed)}"
    if module_key == "purchase_orders":
        supplier = supplier_name(links.parent_indices("supplier_purchase_orders", index, sized)[0])
        return f"{reference_code(module_key, index, seed)} — {supplier}"
    if module_key == "equipment":
        return equipment_name(index, sized)
    if module_key == "maintenance_work_orders":
        device = links.parent_indices("equipment_work_orders", index, sized)[0]
        return f"{equipment_name(device, sized)} service {reference_code(module_key, index, seed)}"
    if module_key == "incident_reports":
        return incident(index)[0]
    if module_key == "staff_credentials":
        kind = credential(index)[1]
        return f"{kind} — {credential(index)[0]}"
    return f"Clinic record {index + 1:04d}"


def lot_number(lot: int) -> str:
    rng = random.Random(f"clinic:lot:{lot}")
    letters = "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") for _ in range(2))
    return f"{letters}{rng.randint(1_000, 9_999)}"


_PINNED_INCIDENTS = (
    ("Vaccine fridge at 9.4 °C at the morning check", "Cold chain", "No harm"),
    ("Patient fainted in the hallway and struck their head", "Patient accident", "Severe"),
)


def incident(index: int) -> tuple[str, str, str]:
    """Summary, type, harm."""
    if index < len(_PINNED_INCIDENTS):
        return _PINNED_INCIDENTS[index]
    choices = vocabulary.INCIDENTS
    summary, kind, harm = choices[(index * 5) % len(choices)]
    if index >= links.PINNED and index % 6 == 1:
        return "BP monitor showed an error during triage", "Medical device", "No harm"
    return summary, kind, harm


_LICENSES = {
    "Dr.": ("Medical license", "DEA registration", "Board certification", "ACLS certification",
            "Malpractice insurance", "Payer enrollment"),
    "NP": ("Nursing license", "Payer enrollment", "BLS certification"),
    "PA-C": ("Medical license", "Payer enrollment", "BLS certification"),
    "RN": ("Nursing license", "BLS certification"),
    "MA": ("BLS certification",),
    "MLS": ("Lab scientist license",),
    "PharmD": ("Pharmacist license", "BLS certification"),
    "CPhT": ("BLS certification",),
}  # fmt: skip


def credential(index: int) -> tuple[str, str]:
    """The staff member and the credential type, matched to the person's role."""
    staff = vocabulary.STAFF_NAMES[index % len(vocabulary.STAFF_NAMES)]
    role = "Dr." if staff.startswith("Dr.") else staff.rsplit(", ", 1)[-1]
    kinds = _LICENSES.get(role, ("BLS certification",))
    return staff, kinds[(index // len(vocabulary.STAFF_NAMES)) % len(kinds)]


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    rng = random.Random(f"{seed}:{module_key}:{field_key}:{index}:clinic-note")
    pools = {
        "patients": vocabulary.APPOINTMENT_NOTES, "coverages": vocabulary.REVENUE_NOTES,
        "appointments": vocabulary.APPOINTMENT_NOTES, "encounters": vocabulary.ENCOUNTER_NOTES,
        "orders": vocabulary.LAB_NOTES, "prescriptions": vocabulary.PHARMACY_NOTES,
        "specimens": vocabulary.LAB_NOTES, "lab_results": vocabulary.LAB_NOTES,
        "lab_qc_runs": vocabulary.LAB_NOTES, "dispenses": vocabulary.PHARMACY_NOTES,
        "stock_lots": vocabulary.PHARMACY_NOTES, "claims": vocabulary.REVENUE_NOTES,
        "claim_responses": vocabulary.REVENUE_NOTES, "payments": vocabulary.REVENUE_NOTES,
        "incident_reports": vocabulary.QUALITY_NOTES, "staff_credentials": vocabulary.QUALITY_NOTES,
    }  # fmt: skip
    if module_key == "claims" and index == 0:
        return "Payer paid $300.00 of the $420.00 charge; $120.00 balance sent to the patient."
    pool = pools.get(module_key, vocabulary.OPERATIONS_NOTES)
    return pool[rng.randrange(len(pool))]


def customer_name(index: int, seed: int) -> str:
    return patient_name(index, seed)


def product_name(index: int, _seed: int) -> str:
    return item_name(index)


def warehouse_name(index: int, _seed: int) -> str:
    return ("Dispensary", "Main stockroom", "Vaccine fridge 1", "Pharmacy fridge 2")[index % 4]


def site_place(index: int, seed: int) -> str:
    return vocabulary.CITIES[(index * 3 + seed) % len(vocabulary.CITIES)]


def site_name(index: int, seed: int, _counts: Mapping[str, int]) -> str:
    return f"{site_place(index, seed)} Family Clinic"


def email_value(module_key: str, index: int, seed: int, _counts: Mapping[str, int]) -> str:
    if module_key == "suppliers":
        domain = vocabulary.SUPPLIER_DOMAINS[index % len(vocabulary.SUPPLIER_DOMAINS)]
        return f"orders@{domain}.example"
    first, last = (part.lower() for part in patient_names(index, seed))
    return f"{first}.{last}{index % 89 + 10}@mailbox.example"


def phone_value(index: int, seed: int) -> str:
    """Fictional US numbers: the 555-0100 to 555-0199 range is reserved for fiction."""
    area = (312, 773, 630, 847, 708, 224)[(index + seed) % 6]
    return f"({area}) 555-01{(index * 13 + seed) % 100:02d}"


def serial_value(index: int, _seed: int) -> str:
    return f"SN{4_810_233 + index * 211:09d}"


def url_value(module_key: str, index: int, _seed: int) -> str:
    slug = payer(index)[2].lower()
    return f"https://providers.{slug}.example/claims"
