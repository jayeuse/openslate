# ruff: noqa: E501 -- copy is kept in complete announcement rows for review.
"""Board posts, event copy, and OpenView names for a Philippine distributor (research §10)."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from operations.sample.packs.fmcg_distributor.catalog import _MODULES

POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    'company': (
        ('Month-end cut-off is the 30th', 'The last day for invoices this month is the 30th. Anything delivered after 17:00 goes on next month\'s books.'),
        ('Welcome to our new colleagues', 'Please welcome the pre-seller and the two warehouse staff who joined this month. Say hello at the Monday huddle.'),
        ('Quarterly all-hands on Friday', 'We review the quarter\'s secondary sales, collections and claims at 16:00 in the warehouse canteen.'),
        ('Typhoon advisory procedure', 'When a signal is raised over our routes, dispatch holds the trucks and the sales team calls outlets instead of visiting.'),
        ('Holiday dispatch schedule', 'There is no dispatch on regular holidays. Orders booked the day before a holiday go out on the next working day.'),
        ('Quarter priorities', 'This quarter we focus on strike rate, on-time delivery and filing every principal claim before its deadline.'),
        ('ID and gate pass reminder', 'Wear your company ID inside the warehouse. Drivers and helpers sign the gate pass on every trip.'),
        ('Keep your contact details current', 'Tell HR if your mobile number or emergency contact changes, so dispatch can reach you on the road.'),
    ),
    'sales': (
        ('Monday sales huddle at 07:30', 'We review last week\'s strike rate, top outlets and this week\'s schemes before the first calls.'),
        ('New PJP from next month', 'The PS04 and PS07 beats change next month. Your new outlet lists are in the beat records.'),
        ('', ''),
        ('Sabaw 12+1 until the 31st', 'Offer the 12+1 on instant noodles to every sari-sari store on your beat. Note it on the order.'),
        ('Monthly target and top performer', 'Thank you to the van team for the best collection week this quarter. Targets for next month are on the board.'),
        ('Route ride-along days', 'Supervisors ride with each pre-seller once this month. Check the calendar for your day.'),
        ('Closed outlets', 'Mark an outlet inactive when the store has closed for good. Do not delete it; credit still needs its history.'),
        ('Mid-month performance review', 'We meet each salesperson for 15 minutes on the 15th to go through strike rate and lines per call.'),
    ),
    'trade_marketing': (
        ('Kestrel Q4 scheme circular received', 'The circular covers evaporated milk and choco drink. Set up the schemes before the 1st.'),
        ('Display audit week', 'We photograph every paid display in the first week of the month. A display not kept up loses its fee.'),
        ('Planogram reset in supermarkets', 'The modern trade planogram reset is on Thursday night. Key accounts confirm the shelf space by Wednesday.'),
        ('Brightbay business review', 'The quarterly business review with Brightbay is on the 20th. Bring secondary sales by outlet class.'),
        ('Signed outlet lists for claims', 'Every scheme claim needs the outlet acknowledgment list signed. Collect them as each scheme ends.'),
        ('New listing fees', 'Two supermarket branches asked for listing fees on the new snack SKUs. The principal decides by Friday.'),
        ('Scheme mechanics on the order', 'Write the scheme code in the order notes when you apply it. Claims cannot be filed without it.'),
        ('Display allowance payments', 'Display fees are paid after the photo audit passes. Failed audits are paid the next month if fixed.'),
    ),
    'purchasing': (
        ('Kestrel price increase on the 1st', 'Kestrel list prices go up 3% on the 1st. Update the SKUs before Monday\'s purchase orders.'),
        ('Weekly PO cut-off by principal', 'Send replenishment POs by Monday noon. The principals confirm by Wednesday.'),
        ('New SKU listings', 'Palmera lists four new sachet SKUs next month. Master data sets them up with GTINs from the principal.'),
        ('Tala allocation notice', 'Tala is on allocation for corned meat this month after a plant shutdown. Order only the allocated cases.'),
        ('Stock cover for the ber months', 'Order up for the ber months. Keep A items at three weeks of cover through December.'),
        ('Delisted SKUs', 'Delisted SKUs stay in the item master for returns and claims. Do not order them again.'),
        ('Principal scorecards', 'We rate each principal on fill rate, lead time and claims paid. The scorecards are due at month-end.'),
        ('PO approval reminder', 'POs of ₱500,000 or more need the finance controller\'s approval before we send them.'),
    ),
    'warehouse': (
        ('Near-expiry list for this week', 'The near-expiry list is posted every Monday. Pick these lots first and offer them on the van routes.'),
        ('Weekly cycle count schedule', 'A items are counted every week, B items every month. The schedule is on the board calendar.'),
        ('Quarter-end stock take', 'The full stock take is on the last Saturday of the quarter. There is no dispatch that day.'),
        ('Pest control visit', 'The pest control contractor treats the warehouse on Saturday. Cover open pallets on Friday afternoon.'),
        ('Safety toolbox talk', 'This week\'s talk is on forklift lanes and safe stacking heights. Meet at 07:15 by loading bay 2.'),
        ('BO cage clean-up', 'Sort the bad orders in the cage by principal before the claims cut-off on the 25th.'),
        ('Receiving cut-off at 15:00', 'Trucks that arrive after 15:00 are received the next morning, except cold room deliveries.'),
        ('FEFO picking reminder', 'Pick by the earliest expiry, not the nearest pallet. Check the lot number on every pick slip.'),
    ),
    'logistics': (
        ('Truck PMS schedule', 'Each truck goes in for preventive maintenance every 5,000 km. The schedule is on the board calendar.'),
        ('Registration renewals', 'Vehicles are renewed in the month that matches the last digit of the plate. Bring the papers to the dispatcher.'),
        ('Holiday dispatch plan', 'Dispatch runs the day after each holiday with two extra trips to clear the backlog.'),
        ('Typhoon route plan', 'When roads flood at Malanday or Tumana, take the MacArthur Highway route and call dispatch.'),
        ('Proof of delivery', 'Get the outlet\'s signature on every invoice. Photograph the shelf when the owner is not around.'),
        ('Failed drops', 'Bring back any order the outlet refused and note the reason. Dispatch books the drop again.'),
        ('Fuel cards', 'Use the fuel card only for the assigned vehicle and keep every receipt for the trip.'),
        ('Loading time', 'Trucks load from 05:00 and leave by 06:30 so we reach the first outlets before they open.'),
    ),
    'credit_collections': (
        ('Statement run on the 1st', 'Statements for every credit outlet go out on the first working day of the month.'),
        ('Weekly collection target', 'This week we aim to collect ₱1.2 million, mostly from 30-day accounts.'),
        ('', ''),
        ('Credit committee this month', 'The credit committee meets on the 20th to review limit increases and new accounts.'),
        ('PDC deposit schedule', 'Deposit post-dated cheques on their date, not before. The cashier keeps the PDC register.'),
        ('Bounced cheques', 'An outlet with a bounced cheque goes on cash on delivery until it pays in full.'),
        ('Van cash remittances', 'Van salesmen remit the day\'s cash at the cashier before 18:00. Variances go to the supervisor.'),
        ('Accounts over 60 days', 'Call every account over 60 days this week. Send a demand letter after the second call.'),
    ),
    'accounting': (
        ('Claim filing deadlines', 'Each principal has its own claim deadline. Scheme claims filed late are rejected without review.'),
        ('Month-end close by the 3rd', 'Post all principal invoices and credit notes by the 3rd so the books close on time.'),
        ('Principal reconciliation meeting', 'We reconcile statements with each principal every quarter. Bring open claims and disputed invoices.'),
        ('Monthly VAT return', 'The VAT return is filed by the 20th. Send sales and purchase summaries to the controller by the 15th.'),
        ('Three-way match', 'Match every principal invoice to its PO and goods receipt before approving payment.'),
        ('BO claims with photos', 'Bad order claims need photos and the return slips. Claims without proof come back from the principal.'),
        ('Year-end audit fieldwork', 'The external auditor starts fieldwork in January. Keep the claim files and supporting documents ready.'),
        ('Credit notes and offsets', 'When a principal settles a claim by offset, record it against the payable, not as cash.'),
    ),
    'project:sales': (
        ('Christmas order drive plan', 'We push gift packs, canned goods and beverages from November. Each beat gets a weekly target.'),
        ('Outlet list for the drive', 'Start with the A and B outlets. C outlets get the drive in the last two weeks.'),
        ('Stock for the drive', 'Purchasing has ordered extra cases of the top 20 SKUs. Check stock before promising delivery.'),
        ('Van routes in December', 'Two extra van tours run on Saturdays in December. Sign up on the calendar.'),
        ('Collections during the drive', 'No new credit orders for accounts over 30 days. Collect the old balance first.'),
        ('Display materials', 'Trade marketing gives each A outlet a hanging display for the season.'),
        ('Weekly drive review', 'We review sales by beat every Monday during the drive.'),
        ('Drive wrap-up', 'We compare the drive with last year after the last delivery before Christmas.'),
    ),
    'project:warehouse': (
        ('Stock take plan', 'The stock take covers the main warehouse, the satellite depot, the BO cage and the cold room.'),
        ('Count teams', 'Each team has a counter and a checker from different departments. Purchasing and credit staff help.'),
        ('Before the count', 'Post every receipt and adjustment by Friday 17:00. Nothing moves during the count.'),
        ('Count sheets', 'Count sheets are printed by bin location on the morning of the count.'),
        ('Variance review', 'The inventory controller reviews any variance over 2% the same day and asks for a recount.'),
        ('Expired and damaged stock', 'Move expired and damaged cases to the BO cage before the count starts.'),
        ('Closing the count', 'Adjustments are posted after the finance controller approves the variance report.'),
        ('Stock take review', 'We review the variances and the time taken after the count closes.'),
    ),
    'project:accounting': (
        ('Claims recovery plan', 'We aim to recover every open scheme, BO and price difference claim older than 60 days.'),
        ('Open claims by principal', 'The claims officer lists open claims by principal with the amount and the age.'),
        ('Missing proof', 'Most returned claims lack signed outlet lists. Trade marketing helps collect them.'),
        ('Principal meetings', 'We meet the top four principals this month to agree on the open claims.'),
        ('Offsets against payables', 'Principals may settle by offset. Record each offset against the right invoice.'),
        ('Write-offs', 'Claims past the principal\'s deadline go to the finance controller for write-off.'),
        ('Weekly status', 'Update each claim\'s status every Friday so the board shows what is still open.'),
        ('Recovery review', 'We review the amount recovered against the open claims at the end of the quarter.'),
    ),
}  # fmt: skip

EVENT_TITLES = (
    "Monday sales huddle",
    "Credit committee",
    "Display audit week",
    "Principal business review",
    "Weekly cycle count",
    "Quarter-end stock take",
    "Truck preventive maintenance",
    "Statement run",
    "Principal reconciliation meeting",
    "Month-end close",
    "Safety toolbox talk",
    "Route ride-along",
)

EVENT_DETAILS = {
    "Monday sales huddle": "The sales team reviews last week's strike rate and this week's schemes.",
    "Credit committee": "Credit reviews limit increases, new accounts and accounts over 60 days.",
    "Display audit week": "Trade marketing photographs every paid display at the outlets.",
    "Principal business review": "Sales, trade marketing and purchasing meet the principal on results and targets.",
    "Weekly cycle count": "The warehouse counts the A items and checks variances over 2%.",
    "Quarter-end stock take": "Every bin is counted; there is no dispatch that day.",
    "Truck preventive maintenance": "The truck goes to the shop for its 5,000 km service.",
    "Statement run": "Credit sends statements to every credit outlet.",
    "Principal reconciliation meeting": "Accounting and the principal agree on open claims and invoices.",
    "Month-end close": "Accounting posts the last invoices and credit notes and closes the month.",
    "Safety toolbox talk": "A short talk on safe stacking, forklift lanes and loading.",
    "Route ride-along": "A supervisor rides with a pre-seller on the day's beat.",
}

EVENT_LOCATIONS = (
    "Main warehouse, Valenzuela",
    "Conference room, second floor",
    "Loading bay 2",
    "Satellite depot, Marikina",
)

BOARD_DESCRIPTIONS = {
    "Christmas Order Drive": "Targets, stock and van routes for the Christmas order drive.",
    "Quarter-End Stock Take": "Teams, count sheets and variance review for the quarter-end stock take.",
    "Principal Claims Recovery": "Open principal claims, missing proof and settlement follow-up.",
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
        raise ValueError("Unknown distributor module")
    return _MODULE_NAMES[module_key]


def post_text(
    board: Mapping[str, Any], index: int, invoice_total: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Return an announcement, including the named invoice part-payment."""
    kind = _board_kind(board)
    if kind == "credit_collections" and index == 2:
        balance = invoice_total - paid
        return (
            "Part payment on a 15-day invoice",
            f"The minimart's invoice is ₱{invoice_total:,.2f}. Its cheque of ₱{paid:,.2f} "
            f"leaves ₱{balance:,.2f} to collect on the next visit. Check the invoice and the "
            "receipt together.",
        )
    if kind == "sales" and index == 2:
        return (
            "Collect before you book",
            f"One minimart still owes ₱{invoice_total - paid:,.2f} on a 15-day invoice. "
            "Collect the balance before booking its next order.",
        )
    title, body = POSTS[kind][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """Record a short update after a distributor announcement is published."""
    return f"{title} (updated)"[:100], f"{body} Updated: confirmed with the department head."[
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
