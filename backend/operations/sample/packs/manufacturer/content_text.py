# ruff: noqa: E501 -- copy is kept in complete announcement rows for review.
"""Board posts, event copy, and OpenView names for a US sauce plant (research §10)."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.manufacturer.catalog import _MODULES

POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    'company': (
        ('Town hall on Thursday at 14:45', 'Both shifts meet in the break room between shifts. We cover the holiday schedule, the safety record and the new lines.'),
        ('200 days without a lost-time injury', 'Thank you for working safely. Keep reporting near misses; every report helps.'),
        ('Holiday production schedule', 'The plant closes for Thanksgiving and the day after. Saturday overtime runs in the four weeks before.'),
        ('Wear your hairnet and beard net', 'Nets go on before the gowning room door. Visitors get theirs at the front desk.'),
        ('Open enrollment for benefits', 'Human Resources holds sign-up sessions in the training room this week, on both shifts.'),
        ('New break room coffee machine', 'The old machine is gone. The new one takes cards and pays back to the safety committee fund.'),
        ('Parking lot resurfacing', 'The north lot is closed on Saturday. Park in the south lot by the tote yard.'),
        ('Update your emergency contact', 'Tell Human Resources if your phone number or emergency contact changed.'),
    ),
    'sales': (
        ('Spring promotion calendar', 'The retail buyers sent the spring ad dates. Enter promo orders at least three weeks before the ad.'),
        ('Price increase on January 1', 'The new price list applies to orders that ship from January 1. Send the letter to every buyer this week.'),
        ('Private label launch', 'The new honey mustard for a private label customer ships in six weeks. Confirm the art approval date.'),
        ('Order cutoff at 13:00', 'Orders entered after 13:00 ship the next working day. Tell the customer when you confirm.'),
        ('Credit holds', 'Finance releases credit holds by 10:00. Do not promise a ship date on a held order.'),
        ('Customer specifications', 'Keep each customer specification in the account file. Ask QA before you agree to a change.'),
        ('Backorder calls', 'Call the buyer on every backorder before 15:00 and note the new date on the order.'),
        ('Holiday ship dates', 'Last ship date before Thanksgiving is the Tuesday. Book carriers early.'),
    ),
    'planning': (
        ('Schedule freeze on Monday', 'The weekly schedule freezes Monday at 10:00. Changes after that need the production manager.'),
        ('Tomato paste contract', 'We book next year\'s paste contract this month. Send the forecast by family to purchasing.'),
        ('Glass and closures reorder points', 'Reorder points for glass and caps go up for the holiday peak.'),
        ('Allergen SKUs run last', 'Plan allergen products at the end of the week, before the full wash.'),
        ('Late spice orders', 'Two spice suppliers are late. Expedite and tell the planner the new dates.'),
        ('MRP run every Monday', 'MRP runs Monday at 06:00 from open orders and the forecast.'),
        ('Supplier scorecards', 'Supplier scorecards for the quarter are ready. Review the late deliveries.'),
        ('Peak builds', 'We build BBQ and wing sauce stock from February to May. Plan the overtime early.'),
    ),
    'warehouse': (
        ('Holiday carrier cutoffs', 'Carriers stop pickups at 12:00 the day before Thanksgiving. Load the full trucks first.'),
        ('Cycle count of A items', 'A items are counted every week. The list is on the board by Monday.'),
        ('Quarterly physical inventory', 'The physical count of B and C items is on the last Saturday of the quarter.'),
        ('FEFO picks', 'Pick the lot with the earliest best-by date first. Check the lot code on every pallet.'),
        ('Trailer inspection', 'Check every trailer for odor, pests and damage before loading, and record the seal number.'),
        ('Quarantine area', 'Incoming lots stay in quarantine until QA releases them. Never pick from the yellow lane.'),
        ('Dock door 3 repair', 'Dock door 3 is closed on Wednesday for the leveler repair.'),
        ('Forklift checks', 'Do the pre-shift forklift check and sign the card before you drive.'),
    ),
    'manufacturing': (
        ('Toolbox talk: lockout and tagout', 'Lock out the energy before you reach into a filler, capper or case packer. No exceptions.'),
        ('Saturday overtime sign-up', 'Sign up for the peak-season Saturday shifts by Wednesday. Seniority applies.'),
        ('Line trial for the new SKU', 'A line trial runs on L2 next Tuesday. The product developer will be on the line.'),
        ('Hot surfaces', 'Kettle jackets and fill bowls are hot. Wear the long gloves at the kettles.'),
        ('Changeover target on L2', 'We aim for a 35-minute changeover on L2. Log every changeover in the downtime events.'),
        ('Shift handover', 'Write the handover notes in the shift report before you leave the line.'),
        ('Metal detector checks', 'Run the wand check at start-up, every two hours and at end of shift.'),
        ('Downtime top five', 'Last week the top losses were filler jams, changeovers and the capper. See the downtime events.'),
    ),
    'quality': (
        ('Certification audit in four weeks', 'The food safety certification audit is booked. Records for the last six months must be complete.'),
        ('Mock recall', 'We run a mock recall on one finished lot this month. The target is full trace in two hours.'),
        ('GMP refresher', 'Every team member takes the GMP refresher this quarter. Sign up for your shift session.'),
        ('Allergen changeover near miss', 'A line started honey mustard before the swab result. Wait for the pass before you start.'),
        ('Record review within 7 working days', 'CCP and monitoring records are reviewed and signed within 7 working days.'),
        ('Positive release', 'Every finished lot stays on QA hold until the batch and CCP records are reviewed.'),
        ('pH meter calibration', 'Calibrate the pH meter with fresh buffers at the start of each shift.'),
        ('Private label customer audit', 'A private label customer audits the plant next month. Prepare the HACCP plan and the training records.'),
    ),
    'maintenance': (
        ('December shutdown plan', 'The two-day shutdown covers the boiler inspection and the L1 filler rebuild.'),
        ('Contractor safety briefing', 'Every contractor gets the safety briefing and a hot work permit before starting.'),
        ('PM compliance', 'Preventive maintenance compliance was 86% last month. The target is 90% or more.'),
        ('Sanitation sign-off', 'After a repair on a food contact surface, QA signs off sanitation before restart.'),
        ('Spare parts cage', 'Sign out every part you take from the MRO cage.'),
        ('Compressed air leaks', 'Tag every air leak you hear. We fix them on the Friday PM route.'),
        ('Boiler inspection', 'The state boiler inspection is booked for the shutdown.'),
        ('Calibration due', 'Scales and thermometers due for calibration are on the list. Book them this week.'),
    ),
    'finance': (
        ('Month-end close calendar', 'Receiving cutoff is the last working day at 15:00. Journals close on the third working day.'),
        ('Standard costs for next year', 'Send the new material prices to cost accounting by the 20th for the standard cost update.'),
        ('', ''),
        ('Retail deductions', 'Retail customers short-pay promotions. Match each deduction to the promotion before you clear it.'),
        ('Invoice match exceptions', 'Supplier invoices that do not match the PO and receipt go to the buyer for an answer.'),
        ('Payment run on Friday', 'The supplier payment run is on Friday. Approve invoices by Thursday noon.'),
        ('Order variances', 'Cost accounting reviews order variances at month end with the production manager.'),
        ('Credit reviews', 'We review the credit limits of the top 20 customers this quarter.'),
    ),
    'project:manufacturing': (
        ('Holiday peak plan', 'We build dressings, relish and seasonings for the holiday peak. The weekly plan is on this board.'),
        ('Overtime crews', 'Saturday crews run L1 and L2. The sign-up sheet is in the break room.'),
        ('Packaging stock', 'Glass, caps and cases are on the reorder list for the peak.'),
        ('Changeover order', 'Allergen SKUs run last in each week of the peak.'),
        ('Daily output', 'Line leads post the daily output here each evening.'),
        ('Temporary staff', 'Six temporary packers start next week. Pair each one with a trained packer.'),
        ('Peak review', 'We review output and overtime after the last peak week.'),
        ('Shipping plan', 'The warehouse ships the peak builds to the retail distribution centers by week.'),
    ),
    'project:quality': (
        ('Audit plan', 'The audit covers the food safety plan, supplier approval, traceability and training.'),
        ('Document review', 'Each SOP owner reviews the documents for the audit by Friday.'),
        ('Traceability exercise', 'We trace one lot back to its material lots and forward to its customers.'),
        ('Internal audit findings', 'Close the findings from the internal audit before the certification audit.'),
        ('Training records', 'Check that every operator has a signed GMP and allergen training record.'),
        ('Pest control file', 'The pest control service report and trend chart must be current.'),
        ('Audit day roles', 'The QA manager leads; the coordinators bring the records.'),
        ('Audit review', 'We review the findings and the corrective actions after the audit.'),
    ),
    'project:maintenance': (
        ('Shutdown scope', 'Boiler inspection, L1 filler rebuild, kettle agitator seals and the dock door 3 leveler.'),
        ('Contractor schedule', 'Contractors arrive at 06:00 on day one. Hot work permits are issued at the gate.'),
        ('Parts list', 'The rebuild kit and the seals are ordered. Check the list before the shutdown.'),
        ('Sanitation after the shutdown', 'Sanitation cleans every line before QA releases it for production.'),
        ('Lockout plan', 'Each job has its own lockout plan. The planner posts them here.'),
        ('Start-up checks', 'Run the metal detector and fill temperature checks before the first batch.'),
        ('Shutdown review', 'We review the jobs, the delays and the costs after start-up.'),
        ('Spare capacity', 'Production builds extra stock the week before the shutdown.'),
    ),
}  # fmt: skip

EVENT_TITLES = (
    "Daily tier meeting",
    "Town hall",
    "Weekly schedule freeze",
    "GMP walk-through",
    "Mock recall",
    "Certification audit",
    "Month-end close",
    "Toolbox talk",
    "Supplier review",
    "Preventive maintenance route",
    "Quarterly physical inventory",
    "Customer visit",
)

EVENT_DETAILS = {
    "Daily tier meeting": "Production, quality and maintenance review yesterday's output, holds and downtime.",
    "Town hall": "Both shifts meet between shifts for plant news and the safety record.",
    "Weekly schedule freeze": "Planning freezes next week's schedule after the MRP run.",
    "GMP walk-through": "QA and a supervisor walk the lines and note GMP findings.",
    "Mock recall": "QA traces one finished lot back to its materials and forward to its customers.",
    "Certification audit": "The food safety certification auditor reviews records and the plant floor.",
    "Month-end close": "Finance closes the month and reviews the order variances.",
    "Toolbox talk": "A short safety talk at the start of the shift.",
    "Supplier review": "Purchasing and QA review supplier scorecards and approvals.",
    "Preventive maintenance route": "Maintenance runs the weekly preventive maintenance route.",
    "Quarterly physical inventory": "The warehouse counts the B and C items.",
    "Customer visit": "A key account visits the plant and the test kitchen.",
}

EVENT_LOCATIONS = (
    "Break room",
    "Training room",
    "Production floor, L2",
    "Front office conference room",
)

BOARD_DESCRIPTIONS = {
    "Holiday Peak Production Plan": "Builds, overtime crews and packaging for the holiday peak.",
    "GFSI Certification Audit": "Records, documents and roles for the food safety certification audit.",
    "December Shutdown": "Jobs, contractors and parts for the two-day December shutdown.",
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
        raise ValueError("Unknown sauce plant module")
    return _MODULE_NAMES[module_key]


def post_text(
    board: Mapping[str, Any], index: int, amount: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Return an announcement, including the named invoice part payment."""
    if _board_kind(board) == "finance" and index == 2:
        balance = amount - paid
        return (
            "Retail invoice part paid",
            f"The retail load invoice billed ${amount:,.2f}. The customer paid ${paid:,.2f} "
            f"and short-paid ${balance:,.2f} for a promotion deduction. Check the invoice and "
            "the payment together before you clear it.",
        )
    title, body = POSTS[_board_kind(board)][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """Record a short update after a plant announcement is published."""
    return f"{title} (updated)"[:100], f"{body} Updated: confirmed with the department manager."[
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
