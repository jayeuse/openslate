"""Natural foundation record text and reserved-domain identifiers (Philippine NGO)."""

from __future__ import annotations

import random
from collections.abc import Mapping

from operations.sample.packs.nonprofit import links, vocabulary
from operations.sample.packs.nonprofit import links_finance as finance
from operations.sample.packs.nonprofit.people import PEOPLE

_PREFIXES = {
    "donors": "DNR-", "campaigns": "CMP-", "donations": "GFT-", "pledges": "PLG-",
    "projects": "", "sites": "SITE-", "activities": "ACT-", "beneficiaries": "BEN-",
    "indicators": "", "feedback_cases": "FBK-", "funds": "FND-", "cash_advances": "CA-",
    "disbursements": "DV-", "purchase_requests": "PR-", "purchase_orders": "PO-",
    "grant_awards": "",
}  # fmt: skip
_START = {"donations": 48_210, "donors": 1_204, "activities": 512, "beneficiaries": 20_431,
          "feedback_cases": 118, "cash_advances": 2_207, "disbursements": 6_118,
          "purchase_requests": 1_406, "purchase_orders": 905, "pledges": 301}  # fmt: skip
_NAMES = {person.key: person.name for person in PEOPLE}
_ITEMS = (
    "Food packs for the next distribution round", "Hygiene kits", "Tarpaulins, 4 x 6 m",
    "Roofing sheets and nails", "Water filters", "Solar lamps", "School kits",
    "Training kits for the bookkeeping batch", "Printing of the beneficiary ID cards",
    "Trucking from the warehouse to the island sites", "Venue and catering for the training",
    "Laptop for the field office", "Fishing gear for the livelihood group",
)  # fmt: skip


def reference_code(module_key: str, index: int, _seed: int) -> str | None:
    if module_key == "projects":
        return project_code(index)
    if module_key == "grant_awards":
        return grant_code(index)
    if module_key == "indicators":
        return indicator_code(index)
    prefix = _PREFIXES.get(module_key)
    if prefix is None:
        return None
    number = _START.get(module_key, 1) + index
    if module_key in {"sites", "funds"}:
        return f"{prefix}{index + 1:02d}"
    return f"{prefix}{number:05d}" if module_key in {"donations", "beneficiaries"} \
        else f"{prefix}{number:04d}"  # fmt: skip


def person(index: int, seed: int, salt: str) -> str:
    """A unique invented Filipino name: first name, middle initial and surname."""
    firsts, lasts, middles = vocabulary.FIRST_NAMES, vocabulary.LAST_NAMES, \
        vocabulary.MIDDLE_INITIALS  # fmt: skip
    size = len(firsts) * len(lasts)
    # 7919 is prime, so each index below the name space gets its own pair.
    pair = (index * 7_919 + seed + len(salt) * 101) % size
    middle = middles[(index // size + index) % len(middles)]
    return f"{firsts[pair % len(firsts)]} {middle}. {lasts[pair // len(firsts)]}"


def donor_name(donor: int, seed: int) -> str:
    kind = links.donor_type(donor)
    name = person(donor, seed, "donor")
    if kind == "Household":
        return f"{name.split('. ', 1)[-1]} family"
    if kind == "Anonymous":
        return f"Anonymous donor {reference_code('donors', donor, seed)}"
    return name


def beneficiary_name(beneficiary: int, seed: int, counts: Mapping[str, int]) -> str:
    """A Duplicate registration repeats the name of an earlier record."""
    if beneficiary >= 7 and links.status("beneficiaries", beneficiary, counts) == "Duplicate":
        beneficiary -= 7
    return person(beneficiary, seed, "beneficiary")


def project_code(project: int) -> str:
    code = vocabulary.PROJECTS[project % len(vocabulary.PROJECTS)][0]
    phase = project // len(vocabulary.PROJECTS)
    return f"{code}-P{phase + 1}" if phase else code


def project_name(project: int) -> str:
    name = vocabulary.PROJECTS[project % len(vocabulary.PROJECTS)][1]
    phase = project // len(vocabulary.PROJECTS)
    return f"{name}, phase {phase + 1}" if phase else name


def grant_code(grant: int) -> str:
    prefix = vocabulary.FUNDERS[links.grant_funder(grant)][3]
    return f"{prefix}-{2025 + grant % 2}-{grant * 37 % 900 + 100:03d}"


def indicator_code(indicator: int) -> str:
    statements = vocabulary.INDICATORS
    level = statements[indicator % len(statements)][0][:2].upper()
    return f"{level}{indicator // len(statements) + 1}.{indicator % len(statements) + 1}"


def organization_name(organization: int) -> str:
    funders = vocabulary.FUNDERS
    if organization < len(funders):
        return funders[organization][0]
    rest = organization - len(funders)
    town = vocabulary.MUNICIPALITIES[rest % len(vocabulary.MUNICIPALITIES)]
    if links.org_role(organization) == "Coordination":
        office = vocabulary.COORDINATION[rest // 6 % len(vocabulary.COORDINATION)]
        return f"{office}, {town}"
    if links.org_role(organization) in {"Funder", "Corporate partner"}:
        base = funders[rest % len(funders)][0]
        return f"{base} {('Small Grants', 'Matching', 'Disaster')[rest // 10 % 3]} Window"
    group = vocabulary.PARTNER_NAMES[rest // 6 % len(vocabulary.PARTNER_NAMES)]
    cycle = rest // (6 * len(vocabulary.PARTNER_NAMES))
    return f"{group} of {town}" + (f" ({vocabulary.BARANGAYS[cycle]})" if cycle else "")


def site_name(site: int) -> str:
    barangay = vocabulary.BARANGAYS[site % len(vocabulary.BARANGAYS)]
    town = vocabulary.MUNICIPALITIES[(site // 3) % len(vocabulary.MUNICIPALITIES)]
    if site == 15:
        return f"Warehouse, Barangay {barangay}, {town}"
    cycle = site // len(vocabulary.BARANGAYS)
    return f"Barangay {barangay}{f' {cycle + 1}' if cycle else ''}, {town}"


def supplier_name(index: int, _seed: int = 0) -> str:
    names = vocabulary.SUPPLIERS
    name = names[index % len(names)][0]
    cycle = index // len(names)
    town = vocabulary.MUNICIPALITIES[cycle % len(vocabulary.MUNICIPALITIES)]
    return f"{name} ({town} branch)" if cycle else name


def campaign_name(campaign: int) -> str:
    name = vocabulary.CAMPAIGNS[campaign % len(vocabulary.CAMPAIGNS)][0]
    cycle = campaign // len(vocabulary.CAMPAIGNS)
    return f"{name}, {vocabulary.CITIES[cycle]} chapter" if cycle else name


def activity_title(activity: int, counts: Mapping[str, int]) -> str:
    options = vocabulary.ACTIVITIES[links.activity_type(activity)]
    base = options[activity % len(options)]
    site = links.activity_site(activity, counts)
    place = vocabulary.BARANGAYS[site % len(vocabulary.BARANGAYS)] if site is not None \
        else "field office"  # fmt: skip
    number = activity // len(options) % 9 + 1
    label = "Round" if links.activity_type(activity) == "Distribution" else "Batch"
    return f"{base}, {label} {number} — {place}"


def staff_name(key: str) -> str:
    return _NAMES[key]


def record_title(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    """Titles the foundation's staff would type; linked names follow the same link rules."""
    code = reference_code(module_key, index, seed)
    titles = {
        "donors": lambda: donor_name(index, seed),
        "campaigns": lambda: campaign_name(index),
        "donations": lambda: f"{code} — {donor_name(links.donation_donor(index, counts), seed)}",
        "pledges": lambda: f"{donor_name(links.pledge_donor(index, counts), seed)} pledge — "
                           f"{campaign_name(links.pledge_campaign(index, counts))}",
        "organizations": lambda: organization_name(index),
        "grant_awards": lambda: f"{code} {project_name(index)}",
        "budget_lines": lambda: f"{line_code(index)} {line_label(index)[0]}",
        "grant_reports": lambda: f"Report for {grant_code(links.report_grant(index, counts))}"
                                 f" — {index // 7 % 4 + 1} of 4",
        "projects": lambda: f"{project_code(index)} {project_name(index)}",
        "sites": lambda: site_name(index),
        "activities": lambda: activity_title(index, counts),
        "beneficiaries": lambda: beneficiary_name(index, seed, counts),
        "assistance": lambda: f"{_assistance_label(index, counts)} — "
                              f"{beneficiary_name(links.assistance_beneficiary(index, counts),
                                                  seed, counts)}",
        "indicators": lambda: f"{code} {_indicator_short(index)}",
        "indicator_results": lambda: f"{indicator_code(links.result_slot(index, counts)[0])} — "
                                     f"reporting period {links.result_slot(index, counts)[1] + 1}",
        "feedback_cases": lambda: f"{code} {_feedback_label(index)}",
        "funds": lambda: fund_name(index, counts),
        "cash_advances": lambda: f"{code} — {staff_name(custodian(index))}",
        "expense_lines": lambda: f"{_expense_label(index)} — {payee(index)}",
        "disbursements": lambda: f"{code} — {voucher_payee(index, seed, counts)}",
        "suppliers": lambda: supplier_name(index),
        "purchase_requests": lambda: f"{_ITEMS[(index * 5 + 3) % len(_ITEMS)]} — {code}",
        "purchase_orders": lambda: f"{code} — "
                                   f"{supplier_name(finance.order_supplier(index, counts))}",
        "volunteers": lambda: person(index, seed, "volunteer-roster"),
    }
    return titles[module_key]()


def line_code(line: int) -> str:
    return f"{line % 7 + 1}.{line // 7 % 9 + 1}"


_LINE_LABELS = (
    ("Facilitator honoraria", "Contractual"), ("Participant meals", "Other direct"),
    ("Distribution items", "Supplies"), ("Field travel", "Travel"),
    ("Staff salaries", "Personnel"), ("Staff benefits", "Fringe"),
    ("Training supplies", "Supplies"), ("Trucking", "Contractual"),
    ("Printing and visibility", "Other direct"), ("Field equipment", "Equipment"),
    ("Monitoring and evaluation", "Travel"), ("Indirect costs", "Indirect"),
)


def line_label(line: int) -> tuple[str, str]:
    """The line's description and its cost category."""
    return _LINE_LABELS[(line * 5) % len(_LINE_LABELS)]


def _assistance_label(item: int, counts: Mapping[str, int]) -> str:
    from operations.sample.packs.nonprofit.values import assistance_type

    return assistance_type(item, counts)


def _indicator_short(indicator: int) -> str:
    statement = vocabulary.INDICATORS[indicator % len(vocabulary.INDICATORS)][2]
    return statement.split(",")[0].split(" (")[0]


def _feedback_label(case: int) -> str:
    from operations.sample.packs.nonprofit.values import feedback_category

    category = feedback_category(case)
    return "Restricted case" if category == "Safeguarding/PSEA" else category


def _expense_label(line: int) -> str:
    categories = ("Participant meals and snacks", "Fuel and boat hire", "Venue rental",
                  "Training materials", "Facilitator honoraria", "Mobile load", "Printing",
                  "Per diem", "Trucking and hauling", "Accommodation")  # fmt: skip
    return categories[(line * 3) % len(categories)]


def expense_category(line: int) -> str:
    return _expense_label(line)


def payee(line: int) -> str:
    return vocabulary.PAYEES[(line * 7) % len(vocabulary.PAYEES)]


def custodian(advance: int) -> str:
    from operations.sample.packs.nonprofit.people import TEAM_KEYS

    team = TEAM_KEYS["programs"]
    return team[1 + advance % (len(team) - 1)] if advance % 4 else team[2]


def fund_name(fund: int, counts: Mapping[str, int]) -> str:
    grant = links.fund_grant(fund, counts)
    if grant is not None:
        return f"{grant_code(grant)} restricted fund"
    names = ("General Fund", "Typhoon Emergency Appeal Fund", "Scholarship Endowment",
             "Corporate Giving Fund")  # fmt: skip
    cycle = fund // len(names)
    return names[fund % len(names)] + (f" {cycle + 1}" if cycle else "")


def voucher_payee(voucher: int, seed: int, counts: Mapping[str, int]) -> str:
    kind, parent = finance.disbursement_kind(voucher, counts)
    if kind == "advance" and parent is not None:
        return staff_name(custodian(parent))
    if kind == "order" and parent is not None:
        return supplier_name(finance.order_supplier(parent, counts))
    others = ("Payroll, field staff", "Payroll, office staff", "Partner tranche transfer",
              "Utilities, main office", "Refund to donor", "Staff reimbursement")
    return others[voucher % len(others)]


def note_text(module_key: str, field_key: str, index: int, seed: int) -> str:
    from operations.sample.packs.nonprofit.catalog import _MODULES

    if module_key == "pledges" and index == 0:
        return "First of four quarterly payments received; ₱90,000 still due."
    if module_key == "cash_advances" and index == 0:
        return "Three receipts liquidated so far; ₱6,250 still to liquidate or refund."
    department = next(module.department for module in _MODULES if module.key == module_key)
    pool = vocabulary.NOTES[department]
    rng = random.Random(f"{seed}:{module_key}:{field_key}:{index}:fcdf-note")
    return pool[rng.randrange(len(pool))]


def email_value(module_key: str, index: int, seed: int, _counts: Mapping[str, int]) -> str:
    if module_key == "organizations":
        return f"partnerships@{_slug(organization_name(index))}.example"
    if module_key == "suppliers":
        return f"sales@{_slug(supplier_name(index))}.example"
    first, *_rest, last = person(index, seed, module_key).lower().replace(".", "").split()
    return f"{first}.{last.replace(' ', '')}{index % 89 + 10}@inbox.example"


def _slug(name: str) -> str:
    words = [word for word in name.lower().replace("'", "").replace("(", " ").split()
             if word.isalpha()][:3]  # fmt: skip
    return "-".join(words) or "fairhaven"


def phone_value(index: int, seed: int) -> str:
    """A Philippine mobile number written the usual way: 09XX XXX XXXX."""
    prefix = ("17", "18", "19", "27", "28", "39", "55", "66", "77", "98")[(index + seed) % 10]
    number = (index * 7_919 + seed * 13 + 4_210_337) % 10_000_000
    return f"09{prefix} {number // 10_000:03d} {number % 10_000:04d}"


def tin(index: int) -> str:
    number = (index * 104_729 + 210_331_077) % 10**9
    return f"{number // 10**6:03d}-{number // 1000 % 1000:03d}-{number % 1000:03d}-000"


def url_value(module_key: str, index: int, _seed: int) -> str:
    return f"https://www.{_slug(organization_name(index))}.example"


def serial_value(index: int, _seed: int) -> str:
    return f"FCDF-ASSET-{1_000 + index:05d}"


def customer_name(index: int, seed: int) -> str:
    return donor_name(index, seed)


def product_name(index: int, _seed: int) -> str:
    return _ITEMS[index % len(_ITEMS)]


def warehouse_name(index: int, _seed: int) -> str:
    return ("Main warehouse", "North field office", "South field office")[index % 3]


def site_place(index: int, _seed: int) -> str:
    return vocabulary.MUNICIPALITIES[index % len(vocabulary.MUNICIPALITIES)]


def site_text(index: int, _seed: int, _counts: Mapping[str, int]) -> str:
    return site_name(index)


def equipment_name(index: int, *_args: object) -> str:
    return ("Field office laptop", "Distribution weighing scale", "Pump boat engine",
            "Satellite phone", "Generator set")[index % 5] + f" {index // 5 + 1}"  # fmt: skip
