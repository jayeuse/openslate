# ruff: noqa: E501 -- copy is kept in complete announcement rows for review.
"""Board posts, event copy, and OpenView names for a US outpatient clinic (research §10)."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.clinic.catalog import _MODULES

POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    'company': (
        ('Flu vaccine clinics open October 6', 'Walk-in flu shots run every weekday from 08:00 to 11:00 and on Saturday mornings through November.'),
        ('Welcome to our new colleagues', 'Please welcome the nurses and front desk staff who joined this month. Say hello at the Monday huddle.'),
        ('Holiday hours', 'The clinic closes on Thanksgiving Day and Christmas Day. The on-call roster is posted on the Clinical Services board.'),
        ('Badge access reminder', 'Wear your badge at all times. Report a lost badge to Operations the same day.'),
        ('Fire drill on Thursday morning', 'We will practise leaving the building at 07:45, before the first appointments. Follow the route by each exit.'),
        ('Quarter priorities', 'This quarter we focus on shorter waiting times, clean claims on first submission and a 90% hand-hygiene score.'),
        ('Parking lot resurfacing', 'The north lot is closed on Saturday. Staff please use the overflow lot behind the pharmacy.'),
        ('Keep your contact details current', 'Tell Human Resources if your phone number or emergency contact changes.'),
    ),
    'patient_access': (
        ('New steps for checking insurance cards', 'Scan both sides of the card and check eligibility before the patient sees the provider.'),
        ('Holiday hours for the front desk', 'Phones open at 08:00 on the day after Thanksgiving. The call center closes early on December 24.'),
        ('No-show callback script updated', 'Call each no-show within one business day and offer the next open slot.'),
        ('Monday huddle at 07:45', 'We review yesterday\'s wait times, today\'s schedule gaps and any registration questions.'),
        ('Duplicate patient charts', 'Search by date of birth before you register a new patient. Send suspected duplicates to the supervisor.'),
        ('Copay collection at check-in', 'Collect the copay before the visit and give the patient a receipt from the system.'),
        ('Interpreter requests', 'Book interpreters when you schedule the visit. Note the language in the appointment.'),
        ('Waitlist for flu season', 'Offer the waitlist when same-day slots are full. The supervisor reviews it at noon.'),
    ),
    'clinical': (
        ('Flu vaccine clinic opens October 6', 'Each provider has two vaccination slots per hour. Record the lot number on every visit.'),
        ('New triage vitals procedure', 'Take a full set of vitals for every acute visit and repeat the BP when it is above 140/90.'),
        ('Holiday on-call roster', 'The on-call roster for Thanksgiving and the December holidays is attached to the calendar event.'),
        ('Monthly clinical meeting', 'This month we review the respiratory season plan and the new standing orders.'),
        ('BLS refresher dates', 'Book a place in the BLS refresher before your certification expires. Quality has the list.'),
        ('Results review turnaround', 'Review and sign new results within two business days. Critical results need a same-day call.'),
        ('Room turnover between visits', 'Wipe down the exam table and the BP cuff after each patient.'),
        ('Referral letters', 'Use the referral template and check the fax number with the front desk before sending.'),
    ),
    'laboratory': (
        ('Influenza A/B kit lot change', 'The new kit lot starts on Monday. Run both control levels before the first patient run.'),
        ('Courier pickup moves to 15:30', 'Send-out specimens must be packed and logged by 15:15.'),
        ('Critical-value list updated', 'The list now includes potassium above 6.0 mmol/L. Call the provider within 30 minutes.'),
        ('Proficiency testing submission due Friday', 'Results go to the reference program by 12:00 on Friday. The lab manager signs off.'),
        ('Analyzer maintenance visit', 'The chemistry analyzer is down on Wednesday from 13:00 to 15:00 for the service visit.'),
        ('Monthly QC review', 'We review the Levey-Jennings charts and any Westgard rule violations on the first Tuesday.'),
        ('Specimen labeling', 'Label tubes at the bedside with two identifiers. Unlabeled tubes are rejected.'),
        ('Phlebotomy hours', 'Fasting draws start at 07:00. Walk-in draws stop at 16:30.'),
    ),
    'pharmacy': (
        ('Inhaler backorder', 'The 90 mcg inhaler is on backorder until next month. A substitute is listed in the item notes.'),
        ('Recall notice for one lot', 'Quarantine every unit of the recalled lot and log the count before the courier collects it.'),
        ('Year-end stock count', 'The dispensary closes at 14:00 on December 28 for the year-end count.'),
        ('Monthly expiry sweep', 'Pull items that expire within 90 days and move them to the quarantine shelf.'),
        ('Fridge temperature checks', 'Record both fridges at the start and end of each day. Report anything above 8 °C at once.'),
        ('Counselling reminder', 'Offer counselling with every new prescription and note it on the dispense.'),
        ('Pickup reminders', 'Text patients when a fill is ready. Fills not collected in seven days go back to stock.'),
        ('Prior authorization queue', 'Check the prior authorization queue at noon and call the payer about anything older than two days.'),
    ),
    'revenue_cycle': (
        ('Payer fee schedules change January 1', 'Load the new fee schedules before the first claim batch of the year.'),
        ('Filing limit reminders', 'Medicaid managed care claims must be filed within 180 days of the visit. Work the aging report weekly.'),
        ('', ''),
        ('Top five denials this month', 'Missing authorization leads the list, followed by coverage ended and missing information.'),
        ('Month-end close', 'Post all remittances by the last working day so the month closes on time.'),
        ('Payer reconciliation meeting', 'We meet each payer representative quarterly to review open claims over 60 days.'),
        ('Patient statements', 'Statements go out every Tuesday. Check the address before you print.'),
        ('Coding questions', 'Send coding questions to the coding inbox with the encounter number, not the patient\'s name.'),
    ),
    'operations': (
        ('Generator load check on Saturday', 'Operations will run the generator under load from 06:00 to 07:00. Lights may flicker.'),
        ('Equipment maintenance schedule', 'The quarterly preventive maintenance week starts on the 14th. Book downtime with the lab.'),
        ('New glove supplier', 'From next month nitrile gloves come from a new supplier. The box size stays the same.'),
        ('Fire drill', 'The fire drill is on Thursday at 07:45. Close the doors as you leave each room.'),
        ('Report broken equipment', 'Tag the device out of service and open a work order with the asset tag.'),
        ('Supply room hours', 'The storekeeper restocks the exam rooms at 07:30 and 13:00.'),
        ('Waiting room chairs', 'New chairs arrive next week. The old chairs go to the staff room.'),
        ('Supplier review', 'We review on-time delivery and backorders with our top suppliers each quarter.'),
    ),
    'quality': (
        ('Hand-hygiene score is 86%', 'Our target is 90%. Use the hand rub on entry and exit of every exam room.'),
        ('Q3 incident trends', 'Most reports were documentation and patient accidents. Thank you for reporting near misses.'),
        ('Privacy refresher due', 'Complete the privacy refresher by the end of the month. It takes about 20 minutes.'),
        ('Monthly quality committee', 'The committee meets on the second Thursday. Send agenda items to the quality officer.'),
        ('Infection-control walk-round', 'The infection prevention nurse walks each area on Wednesday morning.'),
        ('Mock accreditation survey', 'A mock survey runs next month. Keep logs, credentials and policies up to date.'),
        ('Credential renewals', 'Credentialing sends reminders 90 days before a license expires. Reply with the renewal copy.'),
        ('How to file an incident report', 'Anyone can file. Describe what happened, not who to blame, and file it the same day.'),
    ),
    'project:clinical': (
        ('Saturday flu clinic plan', 'We need two nurses, one provider and two front desk staff for each Saturday clinic.'),
        ('Vaccine supply', 'Pharmacy confirms the vaccine order each Wednesday for the next Saturday.'),
        ('Clinic layout', 'Check-in in the lobby, vaccination in exam rooms 1 to 4, observation in the waiting area.'),
        ('Consent forms', 'Use the current consent form and give each patient the information sheet.'),
        ('Walk-in queue', 'Front desk hands out numbered tickets when the line passes 20 people.'),
        ('Documentation', 'Record the lot, site and time of each dose before the patient leaves.'),
        ('Staff sign-up', 'Add your name to the Saturday you can work. Each shift is four hours.'),
        ('Drive review', 'We review the doses given and the waiting times after the last Saturday clinic.'),
    ),
    'project:quality': (
        ('Accreditation readiness plan', 'The plan covers credentials, cold-chain logs, infection control and incident follow-up.'),
        ('Credential file check', 'Credentialing checks every provider file for a current license and board certification.'),
        ('Cold-chain log review', 'Pharmacy confirms that both fridges have two checks on every working day.'),
        ('Policy updates', 'Department leads review their policies and send changes to the quality officer.'),
        ('Mock tracer visits', 'Surveyors will follow one patient visit from check-in to checkout.'),
        ('Open action plans', 'Close the open incident action plans before the mock survey.'),
        ('Staff interviews', 'Surveyors may ask any staff member how to report an incident.'),
        ('Readiness review', 'We review the findings with each department after the mock survey.'),
    ),
    'project:pharmacy': (
        ('Year-end stock count plan', 'The count covers the dispensary shelves, both fridges and the stockroom.'),
        ('Count teams', 'Each team has one counter and one checker. Pharmacy and Operations staff pair up.'),
        ('Expired stock', 'Pull expired lots before the count and log them for destruction.'),
        ('Count sheets', 'Print the count sheets by location on the morning of the count.'),
        ('Variance review', 'The pharmacist-in-charge reviews any variance above 2% the same day.'),
        ('Fridge items', 'Count fridge items last and keep each fridge door open for under one minute.'),
        ('Closing the count', 'Lots are adjusted in the system after the checker signs each sheet.'),
        ('Count review', 'We review the variances and the time taken after the count closes.'),
    ),
}  # fmt: skip

EVENT_TITLES = (
    "Saturday flu vaccination clinic",
    "Monthly clinical meeting",
    "Quality committee",
    "Front desk huddle",
    "BLS refresher",
    "Payer reconciliation meeting",
    "Fire drill",
    "Analyzer maintenance visit",
    "Year-end stock count",
    "Infection-control walk-round",
    "Month-end close",
    "Mock accreditation survey",
)

EVENT_DETAILS = {
    "Saturday flu vaccination clinic": "Walk-in flu shots for patients aged 6 months and older; bring the insurance card.",
    "Monthly clinical meeting": "Providers and nurses review the respiratory season plan and new standing orders.",
    "Quality committee": "Department leads review incident trends, audits and open action plans.",
    "Front desk huddle": "The front desk reviews yesterday's wait times and today's schedule gaps.",
    "BLS refresher": "Hands-on BLS refresher for staff whose certification expires this quarter.",
    "Payer reconciliation meeting": "Revenue cycle and the payer representative review claims open over 60 days.",
    "Fire drill": "Everyone leaves the building by the nearest exit and meets in the north lot.",
    "Analyzer maintenance visit": "The service engineer performs the scheduled maintenance on the chemistry analyzer.",
    "Year-end stock count": "Pharmacy and Operations count every shelf, fridge and the stockroom.",
    "Infection-control walk-round": "The infection prevention nurse checks hand rub, sharps and cleaning logs.",
    "Month-end close": "Revenue cycle posts the last remittances and closes the month.",
    "Mock accreditation survey": "A practice survey of credentials, logs and one patient tracer visit.",
}

EVENT_LOCATIONS = (
    "Main clinic conference room",
    "Staff room, second floor",
    "Lobby and exam rooms 1–4",
    "Laboratory",
)

BOARD_DESCRIPTIONS = {
    "Flu Vaccination Drive": "Staffing, supply and layout for the Saturday flu vaccination clinics.",
    "Accreditation Readiness": "Credentials, logs and action plans to close before the accreditation survey.",
    "Year-End Stock Count": "Teams, count sheets and variance review for the dispensary year-end count.",
}

LAYOUT_NAMES = {
    "table": "{module}: all records",
    "grid": "{module} at a glance",
    "gallery": "{module} cards",
}

_MODULE_NAMES = {module.key: module.name for module in _MODULES}


def _board_kind(board: Mapping[str, Any]) -> str:
    department = board.get("department_key")
    if department is None:
        return "company"
    return f"project:{department}" if board.get("scope") == "project" else str(department)


def _module_label(module_key: str) -> str:
    if module_key not in _MODULE_NAMES:
        raise ValueError("Unknown Clinic module")
    return _MODULE_NAMES[module_key]


def post_text(
    board: Mapping[str, Any], index: int, claim_total: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Return an announcement, including the named claim part-payment."""
    if _board_kind(board) == "revenue_cycle" and index == 2:
        balance = claim_total - paid
        return (
            "Claim part payment posted",
            f"The visit claim's charge is ${claim_total:,.2f}. The payer's remittance of "
            f"${paid:,.2f} leaves ${balance:,.2f} for the patient statement. Review the claim "
            "and the payment together.",
        )
    title, body = POSTS[_board_kind(board)][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """Record a short update after a clinic announcement is published."""
    return f"{title} (updated)"[:100], f"{body} Updated: details confirmed with the department lead."[
        :2000
    ]


def project_board(name: str) -> tuple[str, str]:
    return name, BOARD_DESCRIPTIONS[name]


def view_name(module_key: str, layout: str) -> str:
    return LAYOUT_NAMES[layout].format(module=_module_label(module_key))


def dashboard_name(department_name: str) -> str:
    return f"{department_name} overview"


def report_names(module_key: str, cadence: str, group_name: str | None) -> tuple[str, str]:
    title = f"{cadence.title()} {_module_label(module_key).lower()} summary"
    subtitle = f"Grouped by {group_name.lower()}" if group_name else "All records with row count"
    return title, subtitle
