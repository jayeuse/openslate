# ruff: noqa: E501 -- copy is kept in complete announcement rows for review.
"""Board posts, event copy, and OpenView names for a Philippine community NGO (research §10)."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.nonprofit.catalog import _MODULES

POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    'company': (
        ('Typhoon response update', 'Food packs and hygiene kits reached the first 600 households. Thank you to every team and volunteer.'),
        ('Welcome to our new colleagues', 'Please welcome the facilitators who joined the Programs team this month. Say hello at the Monday huddle.'),
        ('Holiday office hours', 'The office closes from December 24 to January 1. The duty officer list is on the Executive Office board.'),
        ('Safeguarding refresher due', 'Every staff member and volunteer completes the safeguarding refresher by the end of the month.'),
        ('Fire and earthquake drill', 'We practise leaving the office on Thursday at 09:00. Follow the exit signs and meet in the parking area.'),
        ('Annual priorities', 'This year we focus on faster distributions, clean audits and a stronger monthly givers circle.'),
        ('DSWD accreditation renewal', 'The Executive Office is preparing the renewal. Send your department documents by the 15th.'),
        ('Keep your contact details current', 'Tell the admin officer if your phone number or emergency contact changes.'),
    ),
    'resource_mobilization': (
        ('Typhoon Aldren appeal launched', 'The emergency appeal page is live. Share it with your networks; every gift goes to the response fund.'),
        ('Year-end appeal copy review', 'The draft appeal letter is in the shared folder. Send comments by Friday.'),
        ('', ''),
        ('Donor thank-you calls week', 'Each of us calls ten donors next week. The call list is sorted by last gift date.'),
        ('Acknowledgement backlog', 'Gifts from the December peak need acknowledgement receipts by the second week of January.'),
        ('Monthly givers update', 'The Kasama circle now has 47 active monthly givers. Welcome the new ones with a short message.'),
        ('Corporate partner site visit', 'Solace Bank staff visit the livelihood sites next month. Programs is preparing the itinerary.'),
        ('Clean up lapsed donors', 'Mark donors with no gift in 18 months as lapsed before the year-end mailing.'),
    ),
    'grants_partnerships': (
        ('Interim financial report submitted', 'The Q2 financial report went to the funder on time. Thank you, Finance.'),
        ('New award signed', 'The community early warning grant was signed this week. Finance is opening the fund.'),
        ('Realignment approved', 'The funder approved moving savings from travel to distribution items.'),
        ('Proposal deadline', 'The concept note for the coastal schools project is due at the end of the month.'),
        ('Donor monitoring visit', 'The funder visits two livelihood sites next month. Programs will host.'),
        ('Partner due diligence', 'Three partner organizations need updated documents before their MOUs are renewed.'),
        ('Reporting calendar', 'All report due dates for the year are on this board\'s calendar.'),
        ('Budget line watch', 'Lines above 85% spent are listed in the grants dashboard. Check yours before a new purchase.'),
    ),
    'programs': (
        ('Pre-positioning complete', 'Eight hundred food packs are in the main warehouse ahead of the typhoon season.'),
        ('Round 2 distribution schedule', 'Distribution days for each site are on the calendar. Check your assigned barangay.'),
        ('School year opening support', 'School kits go out in the first week of classes. The tutoring schedule follows.'),
        ('Livelihood graduation', 'Batch 3 of the bookkeeping training graduates next month. Invite the barangay officials.'),
        ('Beneficiary list validation', 'Validate the lists with the barangay before each distribution. Note anyone who moved.'),
        ('Consent at registration', 'Read the consent script to every household and tick the box only when they agree.'),
        ('Cash advance reminders', 'Liquidate each advance within 30 days. Finance cannot release a new one while one is open.'),
        ('Field safety', 'Do not cross flooded roads. Call the field office before travelling to the island sites.'),
    ),
    'meal': (
        ('Post-distribution monitoring results', 'Ninety-one percent of households said the kits met their needs. The full summary is attached.'),
        ('Feedback trends', 'Most feedback this quarter asked about the next distribution date. Thank you for logging every call.'),
        ('Quarterly data review', 'Programs and MEAL review the indicator tracker together on the first Tuesday of the quarter.'),
        ('KoBo form update', 'The registration form now asks for household size first. Update the app before your next visit.'),
        ('Data quality visit', 'MEAL visits two sites next month to check the attendance sheets against the records.'),
        ('Sample survey plan', 'The sample survey for the livelihood outcome covers 120 households in four barangays.'),
        ('Indicator definitions', 'Use the definitions in the tracker. Ask MEAL before counting a household twice.'),
        ('Results due dates', 'Submit the quarterly results ten days after the quarter ends.'),
    ),
    'finance': (
        ('Advances outstanding over 30 days', 'The list of open advances is attached. Please liquidate or return the balance.'),
        ('Month-end cut-off', 'Submit receipts by the last working day so the month closes on time.'),
        ('Audit engagement letter signed', 'The external audit fieldwork starts in February. The auditor reads Finance and Procurement records.'),
        ('Weekly payment run', 'Vouchers approved by Thursday noon go out in the Friday payment run.'),
        ('Official receipts only', 'Ask suppliers for an official receipt. A handwritten note needs a certified no-receipt form.'),
        ('Cash count', 'The cashier counts the petty cash with the finance manager every Friday.'),
        ('Bank charges', 'Charge bank fees to the grant line only when the funder allows it.'),
        ('Restricted funds', 'Charge each expense to the right fund and budget line. Ask the grants accountant if unsure.'),
    ),
    'procurement': (
        ('RFQ for shelter kits open', 'Quotations for 400 shelter repair kits are due on the 20th.'),
        ('Supplier accreditation renewal', 'Suppliers renew their documents every year. The list of expiring ones is attached.'),
        ('Bid opening', 'The committee opens the trucking bids on Wednesday at 10:00 in the conference room.'),
        ('Delivery inspection', 'Check each delivery against the PO before signing. Note any short or damaged items.'),
        ('Three quotes rule', 'Requests from ₱50,000 need three quotations unless a single source is justified.'),
        ('Warehouse stock count', 'The warehouse count is on the last Friday of the month.'),
        ('Price list updated', 'The new price list for food packs and hygiene kits is in the shared folder.'),
        ('Conflict of interest', 'Tell the procurement lead if you know a supplier personally.'),
    ),
    'volunteer_engagement': (
        ('Repacking shifts open', 'We need 40 volunteers for the weekend repacking. Sign up on the calendar.'),
        ('First aid refresher', 'The refresher runs on Saturday morning at the main office.'),
        ('Volunteer appreciation night', 'Join us to thank the volunteers who helped in the typhoon response.'),
        ('Background checks', 'Volunteers who work with children need a cleared background check first.'),
        ('Code of conduct', 'Every volunteer signs the code of conduct before their first shift.'),
        ('Data encoding help', 'MEAL needs four volunteers to encode registration forms this month.'),
        ('Shift reminders', 'We send an SMS reminder the day before each shift.'),
        ('New volunteer orientation', 'Orientation is every second Saturday at 09:00.'),
    ),
    'executive_office': (
        ('Board resolution on reserves', 'The board approved a reserves policy of three months of operating costs.'),
        ('Quarterly board meeting', 'The board meets on the third Thursday. Department reports are due a week before.'),
        ('Finance and Audit Committee', 'The committee reviews the audit plan and the year-to-date budget.'),
        ('Safeguarding policy review', 'The updated policy is in the shared folder. Comments to the safeguarding officer.'),
        ('Complaints channels', 'The hotline and SMS line are printed on every distribution banner.'),
        ('Annual members\' meeting', 'Members elect three trustees at the annual meeting.'),
        ('Strategy session', 'Management meets for a planning day on the last Friday of the month.'),
        ('Annual report', 'Send your department highlights for the annual report by the 30th.'),
    ),
    'project:programs': (
        ('Readiness plan', 'The plan covers pre-positioned stock, standby agreements and the volunteer roster.'),
        ('Standby suppliers', 'Procurement confirms the standby agreements for rice, kits and trucking.'),
        ('Early warning drills', 'Each early warning committee runs a drill before the peak months.'),
        ('Evacuation center list', 'Check the list of evacuation centers with each municipality.'),
        ('Rapid needs assessment team', 'Two teams stand by to assess the worst-hit barangays within 48 hours.'),
        ('Cash readiness', 'Finance keeps a cash advance ready for the first distribution.'),
        ('Volunteer roster', 'Volunteer Engagement keeps 60 trained repacking volunteers on call.'),
        ('Readiness review', 'We review what worked after the first response of the season.'),
    ),
    'project:resource_mobilization': (
        ('Year-end appeal plan', 'The appeal runs from mid-November to December 31, with a match week in December.'),
        ('Appeal story', 'This year\'s story follows a family from the livelihood program.'),
        ('Match week', 'A corporate partner matches gifts during the second week of December.'),
        ('Mailing list', 'Check the donor list for lapsed and do-not-contact donors before mailing.'),
        ('Giving page', 'The giving page shows the appeal goal and the amount raised.'),
        ('Thank-you plan', 'Every gift gets an acknowledgement within a week; major gifts get a call.'),
        ('Daily totals', 'Gift processing posts the daily totals here during the last two weeks.'),
        ('Appeal review', 'We review the results and the cost per peso raised in January.'),
    ),
    'project:finance': (
        ('Audit preparation plan', 'The plan covers the fund ledgers, advance liquidations and procurement files.'),
        ('Document checklist', 'Each department checks its files against the auditor\'s list.'),
        ('Open advances', 'Liquidate every open advance before the fieldwork starts.'),
        ('Procurement files', 'Each purchase order file needs its request, quotes and delivery receipt.'),
        ('Fund balances', 'The grants accountant reconciles each restricted fund with its grant report.'),
        ('Auditor questions', 'Send the auditor\'s questions to the finance manager, not straight to the funder.'),
        ('Fieldwork schedule', 'The auditor visits the main office and one field office.'),
        ('Audit close-out', 'We review the management letter and assign each finding an owner.'),
    ),
}  # fmt: skip

EVENT_TITLES = (
    "Weekend repacking",
    "Monthly management meeting",
    "Quarterly board meeting",
    "Distribution day",
    "Quarterly data review",
    "Month-end close",
    "Bid opening",
    "Donor thank-you calls",
    "Test run of the early warning system",
    "Volunteer orientation",
    "Finance and Audit Committee",
    "Livelihood graduation",
)

EVENT_DETAILS = {
    "Weekend repacking": "Volunteers repack rice, canned goods and hygiene items at the main warehouse.",
    "Monthly management meeting": "Department heads review the month's work, risks and open decisions.",
    "Quarterly board meeting": "The board reviews the program, finance and safeguarding reports.",
    "Distribution day": "Validated households collect their packs at the barangay hall.",
    "Quarterly data review": "Programs and MEAL review the indicator tracker and the feedback trends.",
    "Month-end close": "Finance posts the last receipts and closes the month.",
    "Bid opening": "The procurement committee opens and records the bids.",
    "Donor thank-you calls": "Resource Mobilization calls donors to thank them for their gifts.",
    "Test run of the early warning system": "The early warning committee sends the alert and checks who received it.",
    "Volunteer orientation": "New volunteers learn the code of conduct and the safety rules.",
    "Finance and Audit Committee": "The committee reviews the audit plan and the budget to date.",
    "Livelihood graduation": "Training participants receive their certificates and starter kits.",
}

EVENT_LOCATIONS = (
    "Main office conference room",
    "Main warehouse",
    "Barangay hall",
    "North field office",
)

BOARD_DESCRIPTIONS = {
    "Typhoon Response Readiness": "Stock, standby agreements, drills and rosters ready before the typhoon peak.",
    "Year-End Appeal Planning": "Story, mailing, giving page and thank-you plan for the year-end appeal.",
    "Annual Audit Preparation": "Files, liquidations and fund balances to close before the audit fieldwork.",
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
        raise ValueError("Unknown Fairhaven module")
    return _MODULE_NAMES[module_key]


def post_text(
    board: Mapping[str, Any], index: int, pledge_total: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Return an announcement, including the named pledge part-payment."""
    if _board_kind(board) == "resource_mobilization" and index == 2:
        balance = pledge_total - paid
        return (
            "First pledge payment received",
            f"A ₱{pledge_total:,.0f} pledge to the scholarship program is paid in four "
            f"installments. The first payment of ₱{paid:,.0f} came in this week, leaving "
            f"₱{balance:,.0f} due. Review the pledge and the gift together.",
        )
    title, body = POSTS[_board_kind(board)][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """Record a short update after an announcement is published."""
    return f"{title} (updated)"[:100], f"{body} Updated: details confirmed with the department head."[
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
