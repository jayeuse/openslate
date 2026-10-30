# ruff: noqa: E501 -- copy is kept in complete announcement rows for review.
"""Board posts, event copy, and OpenView names for a Philippine city hall (research §10)."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.local_government.catalog import _MODULES

POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    'company': (
        ('City hall opens on Saturdays in January', 'The permit, treasury and assessment windows open from 08:00 to 17:00 on the first three Saturdays of January for renewals.'),
        ('Flag ceremony every Monday at 07:45', 'All offices join the flag ceremony at the city hall grounds. Department heads take attendance.'),
        ('Holiday schedule for November', 'City hall is closed on November 1, 2 and 30. Frontline offices post a notice at their windows.'),
        ('Wear your ID inside city hall', 'Wear your city government ID at all times. Report a lost ID to Human Resources the same day.'),
        ('Earthquake drill on Thursday', 'The quarterly earthquake drill starts at 09:00. Follow your office floor warden to the open grounds.'),
        ('This year\'s service priorities', 'We focus on faster permits, clean audit results and a quicker response to drainage complaints.'),
        ('Parking at the annex', 'The annex parking area is closed on Friday for resurfacing. Please use the plaza parking lot.'),
        ('Update your contact details', 'Tell Human Resources if your mobile number or emergency contact changes.'),
    ),
    'bplo': (
        ('Renewal deadline is January 20', 'Business permits and business tax must be renewed by January 20. Late renewals pay a 25% surcharge and 2% interest a month.'),
        ('List of renewal requirements', 'Bring last year\'s permit, the audited financial statement or sworn gross sales, the barangay clearance and the lease contract if renting.'),
        ('Joint inspections start in February', 'The joint inspection team visits businesses by barangay from February to March. The schedule is on this board.'),
        ('Monday huddle at 08:00', 'We review yesterday\'s queue, the applications returned for compliance and today\'s inspections.'),
        ('Negative list update', 'Businesses that failed the joint inspection are added to the negative list until they comply.'),
        ('One-day renewal standard', 'A complete renewal is released within one working day. Tell the chief if an application goes past it.'),
        ('Online renewal link', 'Applicants can file renewals through the online form. Print the assessment for the treasury window.'),
        ('Retirement of business', 'A business that closes files a retirement application with the closing balance and the last permit.'),
    ),
    'building_official': (
        ('Updated schedule of fees', 'The updated schedule of building fees applies to applications filed from the first of next month.'),
        ('Seminar for contractors', 'A half-day seminar on the new permit steps is open to contractors and engineers in the city.'),
        ('Processing times', 'Simple applications take 3 working days, complex ones 7 and highly technical ones 20. Mark any that pass the limit.'),
        ('Site inspection schedule', 'Inspectors go out on Tuesdays and Thursdays. Book the site visit when the application is complete.'),
        ('Occupancy permits', 'Apply for the certificate of occupancy after the final inspection. Bring the as-built plans.'),
        ('Illegal construction reports', 'Reports from the hotline go to the inspector of the barangay. A stop-work order follows if no permit is found.'),
        ('Soil test reports', 'A soil test report is needed for buildings of three storeys or more.'),
        ('System maintenance on Friday', 'The permit system is down on Friday from 17:00 to 20:00 for maintenance.'),
    ),
    'public_works': (
        ('Pothole blitz week', 'All crews patch potholes on the main roads this week. Log each patch in the work order.'),
        ('Desilting before the rains', 'Crews desilt the canals in the low barangays in March and April, before the rainy season.'),
        ('Hotline numbers', 'Residents can report road, drainage and streetlight problems through the hotline or the online form.'),
        ('Crew assignments', 'Crew 1 and 2 handle roads, Crew 3 drainage, Crew 4 garbage pickup, and the electrical team streetlights.'),
        ('Cold-mix asphalt stock', 'We have 120 bags of cold mix left. Tell the foreman before a job that needs more than 10 bags.'),
        ('Close requests with notes', 'Write what was done and when in the request before you set it to Fixed.'),
        ('Flood watch', 'During heavy rain, crews stand by at the motorpool. The engineer assigns them by barangay.'),
        ('Streetlight survey', 'The electrical team checks every streetlight on the national road this month.'),
    ),
    'treasury': (
        ('Property tax due March 31', 'Pay the first-quarter real property tax by March 31. Full payment for the year earns a discount of up to 20%.'),
        ('Collection hours', 'Collection windows are open from 08:00 to 16:30. The cashier closes the day\'s collection at 16:30.'),
        ('', ''),
        ('E-payment channels', 'Taxpayers can pay through the online payment link and the partner banks. Post each payment with its reference.'),
        ('Daily deposit report', 'Each collector submits the deposit report before 17:00. The deposit goes to the bank the next morning.'),
        ('Spoiled receipts', 'Keep spoiled receipts in the booklet and mark them cancelled. Never tear them out.'),
        ('Quarterly business tax', 'Business tax installments are due in the first 20 days of April, July and October.'),
        ('Check payments', 'Check payments clear in three working days. The permit is released after the check clears.'),
    ),
    'budget_accounting': (
        ('First-quarter allotments released', 'The allotments for the first quarter are released. Offices can now file obligation requests.'),
        ('DV submission cutoff', 'Submit disbursement vouchers by the 25th of the month to be paid within the month.'),
        ('Complete supporting documents', 'A voucher for goods needs the purchase order, the acceptance report and the invoice. Incomplete vouchers are returned.'),
        ('Budget call for next year', 'The budget call goes out in June. Offices send their proposals by July 15.'),
        ('Pre-audit turnaround', 'We pre-audit a complete voucher within three working days.'),
        ('Month-end closing', 'Journal entries for the month close on the third working day of the next month.'),
        ('Audit observation memorandum', 'Offices answer audit observations within 30 days. Send the reply through the accounting office.'),
        ('Year-end obligations', 'Obligation requests for this year must be filed by December 15.'),
    ),
    'procurement': (
        ('Annual procurement plan published', 'The annual procurement plan is posted. Purchase requests must match an item in the plan.'),
        ('Pre-bid conference dates', 'Pre-bid conferences for projects of 3 million pesos or more are on the board calendar.'),
        ('BAC meets every Tuesday', 'The Bids and Awards Committee meets every Tuesday at 14:00 in the conference room.'),
        ('Supplier registration drive', 'Suppliers can register with the city in the first two weeks of the quarter.'),
        ('Small value procurement', 'Small value procurement needs at least three quotations. Post requests above 200,000 pesos for three days.'),
        ('Deliveries to the warehouse', 'Deliveries are received from 08:00 to 15:00. The inspection officer checks each delivery the same day.'),
        ('Failed biddings', 'After a failed bidding the end-user office reviews the specifications before the re-bid.'),
        ('Purchase order follow-up', 'Call suppliers whose delivery is due this week and note the answer in the order.'),
    ),
    'city_clerk': (
        ('Weekly session calendar', 'The council holds its regular session every Wednesday at 10:00 in the session hall.'),
        ('Public hearing on the revenue code', 'A public hearing on the revenue code amendment is open to all taxpayers.'),
        ('Mass wedding in February', 'The civil registry accepts applications for the mass wedding until January 31.'),
        ('FOI desk hours', 'The FOI desk is open from 08:00 to 17:00. Requests are answered within 15 working days.'),
        ('Routing slips', 'Attach a routing slip to every incoming document and note the action officer.'),
        ('Records room', 'Borrowed files go back to the records room within five working days.'),
        ('Birth registration reminder', 'Births are registered within 30 days. Late registrations are posted for 10 days.'),
        ('Ordinance copies', 'Certified copies of ordinances are available at the records window for a fee.'),
    ),
    'project:bplo': (
        ('Renewal drive plan', 'Extra windows, Saturday hours and a one-stop desk with the treasury and the fire station.'),
        ('Queue numbers', 'Hand out queue numbers from 07:30. The guard closes the line at 16:00.'),
        ('Barangay clearance desk', 'A barangay clearance desk sits beside window 1 during the drive.'),
        ('Assessment staff', 'Two treasury assessors sit with us from January 2 to 20.'),
        ('Daily report', 'Each evening we post the number of permits released and still pending.'),
        ('Late renewals', 'Explain the surcharge to late renewals before the assessment.'),
        ('Volunteers', 'Staff from other offices help with the queue. Sign up on this board.'),
        ('Drive review', 'We review the release times and the complaints after January 20.'),
    ),
    'project:public_works': (
        ('Drainage program plan', 'We desilt every main canal before June and clear the inlets every month of the rainy season.'),
        ('Canal list', 'The canal list by barangay is attached. Crews mark each canal when it is done.'),
        ('Equipment', 'The backhoe and the dump truck are reserved for the program on Mondays and Thursdays.'),
        ('Silt disposal', 'Silt goes to the approved disposal site only. Never leave it on the road shoulder.'),
        ('Barangay coordination', 'Tell the barangay captain the day before a crew arrives.'),
        ('Flood reports', 'Drainage and flooding requests are high priority during the program.'),
        ('Safety', 'Crews wear boots, gloves and vests. Never enter a canal alone.'),
        ('Program review', 'We review the flooding requests by barangay at the end of November.'),
    ),
    'project:budget_accounting': (
        ('Budget preparation calendar', 'Budget call in June, proposals by July 15, technical hearings in August and the executive budget by October 16.'),
        ('Office proposals', 'Each office sends its proposal with last year\'s actual spending and this year\'s obligations.'),
        ('Technical hearings', 'The hearings run by office. The schedule is on the board calendar.'),
        ('Income estimates', 'The treasury sends the income estimates by July 15.'),
        ('Personnel services cap', 'Personnel services must stay within the legal cap of the income.'),
        ('Council deliberation', 'The appropriation ordinance goes to the council in October for approval before December 31.'),
        ('Supplemental budget', 'Requests for a supplemental budget come with the source of funds.'),
        ('Preparation review', 'We review the calendar and the late proposals after the budget is enacted.'),
    ),
}  # fmt: skip

EVENT_TITLES = (
    "Regular council session",
    "Flag ceremony",
    "BAC meeting",
    "Joint inspection day",
    "Technical budget hearing",
    "Pre-bid conference",
    "Earthquake drill",
    "Canal desilting day",
    "Public hearing on the revenue code",
    "Mass wedding",
    "Month-end closing",
    "Saturday renewal windows",
)

EVENT_DETAILS = {
    "Regular council session": "The council takes up measures on first, second and third reading.",
    "Flag ceremony": "All offices meet at the city hall grounds for the Monday flag ceremony.",
    "BAC meeting": "The Bids and Awards Committee opens bids and reviews evaluation reports.",
    "Joint inspection day": "The joint inspection team visits businesses in one barangay.",
    "Technical budget hearing": "Offices present their budget proposals to the budget committee.",
    "Pre-bid conference": "Bidders ask questions on the specifications before the bid deadline.",
    "Earthquake drill": "Everyone leaves the building by the nearest exit and meets at the open grounds.",
    "Canal desilting day": "Crews desilt the main canal of one barangay with the residents' help.",
    "Public hearing on the revenue code": "Taxpayers give their views on the proposed revenue code amendment.",
    "Mass wedding": "The civil registry and the mayor's office hold the mass wedding for registered couples.",
    "Month-end closing": "Accounting closes the books and posts the journal entries for the month.",
    "Saturday renewal windows": "Permit and treasury windows open on Saturday for business renewals.",
}

EVENT_LOCATIONS = (
    "Session hall, city hall",
    "City hall conference room",
    "City hall grounds",
    "Treasury windows, ground floor",
)

BOARD_DESCRIPTIONS = {
    "Business Permit Renewal Drive": "Windows, staff and daily reports for the January renewal peak.",
    "Rainy Season Drainage Program": "Canal desilting, crews and flood reports from March to November.",
    "Annual Budget Preparation": "Calendar, proposals and hearings for next year's appropriation ordinance.",
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
        raise ValueError("Unknown city government module")
    return _MODULE_NAMES[module_key]


def post_text(
    board: Mapping[str, Any], index: int, amount_due: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Return an announcement, including the named quarterly installment."""
    if _board_kind(board) == "treasury" and index == 2:
        balance = amount_due - paid
        return (
            "First-quarter business tax installment posted",
            f"The order of payment assessed ₱{amount_due:,.2f} for the year. The first-quarter "
            f"receipt of ₱{paid:,.2f} leaves ₱{balance:,.2f} for the next three quarters. "
            "Check the order and the receipt together.",
        )
    title, body = POSTS[_board_kind(board)][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """Record a short update after a city hall announcement is published."""
    return f"{title} (updated)"[:100], f"{body} Updated: details confirmed with the office head."[
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
