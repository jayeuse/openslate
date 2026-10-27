# ruff: noqa: E501 -- one post or event line per row keeps the copy readable and editable.
"""Board posts, events and OpenView names written the way a team would write them."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any

# Eight posts per Board, keyed by Board kind. Order follows the post life cycle:
# drafts, published, scheduled, archived (two each).
POSTS: dict[str, tuple[tuple[str, str], ...]] = {
    "company": (
        ("Year-end party: save the date", "The party is on December 12 at 6 PM. The program and raffle details follow on this Board."),
        ("Holiday payroll schedule", "Salaries for the second half of December are released on December 22."),
        ("Office closed on Monday for the national holiday", "All sites follow the holiday schedule. Warehouses keep a small crew for urgent dispatch; ask your department lead about coverage."),
        ("Welcome to our new team members", "Please welcome the people who joined Field Operations and Finance this month. Say hello when you see them at the Pasig office."),
        ("Fire drill at head office on Thursday, 10 AM", "The drill takes about 20 minutes. Use the nearest exit and gather at the parking area."),
        ("Q4 priorities", "Thank you for a strong quarter. Our focus for Q4: on-time deliveries, faster service response, and a clean month-end close."),
        ("New visitor rules at all warehouses", "Visitors sign in at the guard house and wear a vest and hard hat in the loading area."),
        ("Update your emergency contact", "HR needs a current emergency contact for everyone. Send changes to your department lead by Friday."),
    ),
    "sales": (
        ("Trade show booth schedule", "We have a booth at the logistics expo next month. Sign up for a shift on this Board."),
        ("Welcome Bea to the team", "Bea joins as Inside Sales Representative and handles walk-in and phone orders."),
        ("Q4 account targets posted", "Targets for October to December are in the shared folder. Review yours with Marina by Friday."),
        ("Attach the customer PO to every order", "Finance cannot invoice without it. Scan and e-mail the PO before you confirm the order."),
        ("Packaging price increase from November 1", "Supplier costs went up 6%. Honor open quotes until they expire; new quotes use the updated price list."),
        ("Discounts above 10% need approval", "The Sales Manager approves any discount above 10% before the quote goes out."),
        ("Follow up on every sent quote", "Call or e-mail within five working days and note the result on the quote."),
        ("Accounts due for renewal this month", "The renewal list is in Views. Log every call on the customer record."),
    ),
    "service": (
        ("Holiday service coverage", "Emergency requests only from December 24 to January 2."),
        ("New checklist for site visits", "Photograph the equipment tag and add findings before you close the request."),
        ("After-hours callout roster for October", "The roster is posted. If you swap a shift, tell the dispatcher."),
        ("Urgent requests: first response within 4 hours", "Log the first customer contact as a request update so we can track it."),
        ("Keep internal notes internal", "Customers see only updates marked visible. Use internal updates for anything else."),
        ("Spare blast chiller available for loan", "One spare unit is at the Navotas warehouse for customers with a Gold agreement."),
        ("Agreements ending next month", "Contact customers whose agreements end in November and log the result."),
        ("Customer survey results", "Customers rated our response 4.3 out of 5. Most comments ask for clearer arrival times."),
    ),
    "field": (
        ("Great work on the Mandaue shutdown", "The team finished the plant shutdown work a day early. Thank you."),
        ("Parts kit for reefer jobs", "Take the standard reefer kit: door seal, return-air sensor and contactor."),
        ("Lock out before every repair", "Lock out and tag the unit before you open any panel. No exceptions."),
        ("Forklift PMS this week", "All forklifts at Navotas get their monthly PMS. Plan deliveries around the downtime."),
        ("New torque wrenches in the tool room", "Sign them out in the logbook and return them the same day."),
        ("Refrigerant handling certification", "Technicians who handle refrigerant renew their certification before December."),
        ("Record labor hours on every work order", "Payroll and billing both use these hours."),
        ("Book the service van early", "Book the van at least two days ahead for jobs outside Metro Manila."),
    ),
    "inventory": (
        ("Variance review results", "Last month's count variance was below 1%. Thanks to everyone who helped."),
        ("Warehouse closed Saturday morning for pest control", "No receiving or dispatch between 7 AM and 1 PM."),
        ("Quarterly cycle count starts Monday", "Receiving closes at 3 PM on count days. Post all transfers before 2 PM."),
        ("New bin labels in aisles 1 to 6", "Scan the new labels only. The old labels come off this week."),
        ("Low stock: seal kits and stretch film", "Purchasing has placed orders. Reserve stock for confirmed orders only."),
        ("Quality hold area moved", "Items on quality hold now go to the caged area beside dock 3."),
        ("Oldest stock first", "Pick the oldest ice packs and liners first. Check the date on the carton."),
        ("How to report damaged stock", "Photograph the item and record a stock movement with the reason Quality check."),
    ),
    "purchasing": (
        ("Backorders to watch", "Hydraulic seal kits and LED high-bay lights are on backorder until next month."),
        ("New payment terms with key suppliers", "Three suppliers agreed to Net 45. The details are in each supplier record."),
        ("Approved supplier list updated", "Two suppliers moved to On hold after late deliveries. Check the list before you raise a PO."),
        ("PO approval limits", "POs above ₱100,000 need the Purchasing Manager's approval."),
        ("Supplier visit on Tuesday", "The packaging supplier visits to review delivery performance."),
        ("Sea freight rates went up", "Freight to Cebu and Davao increased this month. Include freight in the landed cost."),
        ("Record the PO number on every receipt", "Receiving matches each goods receipt to its PO."),
        ("Year-end ordering cut-off", "The last day to order for delivery this year is December 15."),
    ),
    "finance": (
        ("", ""),  # Replaced by the partially paid invoice post.
        ("Month-end close calendar", "Submit expenses by the 25th. Issue invoices for delivered orders by the last working day."),
        ("Official receipt for every payment", "Issue an official receipt for each payment and record its number on the payment."),
        ("Overdue accounts review", "We review invoices more than 30 days overdue every Thursday. Sales, join if your account is on the list."),
        ("Meal expenses", "Meals above ₱1,500 per person need a receipt and the business reason."),
        ("Quarterly tax filing", "Filing is due on the 25th. Send supporting documents to Celine."),
        ("Credit notes need approval", "Only the Finance Manager approves credit notes. Attach the reason and the original invoice."),
        ("Confirm bank detail changes by phone", "Before you pay a supplier's new account, confirm it by phone. Never rely on e-mail alone."),
    ),
    "project:sales": (
        ("Lessons learned session", "Share what worked at the January review meeting."),
        ("Final push before quarter end", "Close the remaining renewals by December 20."),
        ("Q4 renewal list is final", "42 accounts renew this quarter. Owners are in the list; update the status weekly."),
        ("Renewal offer approved", "Customers who renew for two years get a 5% discount and priority service."),
        ("Week 2 status", "18 renewals confirmed and 6 at risk. At-risk accounts are flagged in Views."),
        ("Call plan for at-risk accounts", "Managers call each at-risk account this week."),
        ("Use the approved renewal letter", "The letter is in the shared folder. Do not change the terms."),
        ("Two large accounts renewed", "Both renewed for two years on the new service tier."),
    ),
    "project:service": (
        ("Closing the recovery plan", "We meet the response target three weeks in a row. The plan closes this Friday."),
        ("Week 4 status: on track", "Median first response is now 3 hours 10 minutes."),
        ("Recovery plan for late responses", "Goal: first response within 4 hours for every urgent request."),
        ("Daily stand-up at 8:30 AM", "Ten minutes, dispatch room. Bring your open requests."),
        ("Backlog down to 35 open requests", "Down from 80 at the start of the plan."),
        ("Callback script for affected customers", "Use the script in the shared folder when you call customers we kept waiting."),
        ("Extra technician on weekends", "One more technician covers Saturday and Sunday until the backlog clears."),
        ("Service credits approved", "Customers with missed response times get one month of service credit."),
    ),
    "project:field": (
        ("Next phase: dock equipment", "After the forklifts, we start on dock levelers and scissor lifts."),
        ("Breakdowns down 20%", "Fleet breakdowns fell from 1.8 to 1.4 per unit per month."),
        ("Fleet health baseline", "We track breakdowns per unit per month. The current baseline is 1.8."),
        ("Battery replacement program", "Reach truck batteries older than four years are replaced this quarter."),
        ("Telematics trial on five reach trucks", "The trial records hours and impacts. Operators get a briefing on Monday."),
        ("Top 10 units by downtime", "The list is in Views. Each unit gets a root-cause review."),
        ("Operator training schedule", "Refresher training runs every Wednesday afternoon in October."),
        ("Spare parts minimums updated", "Minimum stock for fleet spares is updated in Inventory."),
    ),
    "project:inventory": (
        ("Project wrap-up", "Stock-outs fell by half. Thank you to Inventory and Purchasing."),
        ("Supplier lead times reviewed", "Lead times for the top 50 items are updated on each product."),
        ("Safety stock review", "We set safety stock for the 50 fastest-moving items."),
        ("Second supplier for stretch film", "A second supplier is approved, so one late delivery no longer stops dispatch."),
        ("Buffer stock at the Cebu hub", "Cebu now holds two weeks of stock for Visayas customers."),
        ("Prepare for the typhoon season", "Move critical stock off the floor at Navotas and Mandaue before the rains peak."),
        ("Reorder points updated", "New reorder points apply from Monday."),
        ("Monthly stock-out report", "Stock-outs this month: 6 items, down from 14."),
    ),
    "project:finance": (
        ("Target: close in 4 days next month", "We aim to cut one more day from the close."),
        ("Close completed in 5 days", "This month's close took 5 working days, down from 8."),
        ("Close checklist for this month", "The checklist is pinned. Mark each item when it is done."),
        ("Accrual cut-off", "Send accruals for goods received but not billed by the 28th."),
        ("Bank reconciliation status", "All accounts are reconciled except the payroll account."),
        ("Unbilled deliveries", "Sales, confirm delivered orders that are not yet invoiced by Wednesday."),
        ("Expense reports outstanding", "Twelve expense reports are still open. Submit them this week."),
        ("Credit notes to review", "Four credit notes wait for approval before the close."),
    ),
}  # fmt: skip

EVENT_DETAILS = {
    "Customer account review": "Review open orders, overdue invoices and next steps for the top accounts.",
    "Service response checkpoint": "Check urgent requests that are close to the response target.",
    "Equipment inspection window": "Units due for inspection are listed in Views. Bring the checklists.",
    "Inventory replenishment review": "Go through items below reorder point and agree what to order.",
    "Supplier delivery coordination": "Confirm delivery dates for open POs and flag any delays.",
    "Finance close preparation": "Agree the close checklist, owners and cut-off times.",
    "Regional operations handoff": "Hand over open work between the Luzon and Visayas teams.",
    "Quality follow-up": "Review items on quality hold and decide: return, rework or release.",
    "Weekly capacity review": "Match next week's jobs to technicians and vehicles.",
    "Customer commitment check": "Check promised dates on open orders against current stock.",
    "Maintenance planning session": "Plan next month's PMS and book downtime with each site.",
    "Department metrics review": "Review this month's numbers and agree one improvement.",
}  # fmt: skip
EVENT_LOCATIONS = ("Pasig head office, Conference Room 2", "Navotas warehouse training room",
                   "Mandaue hub meeting room", "Video call")  # fmt: skip

_BOARD_DESCRIPTIONS = {
    "Customer Renewal": "Renewals due this quarter: owners, status and next steps.",
    "Service Recovery": "Plan to bring urgent-request response back within 4 hours.",
    "Fleet Reliability": "Cut forklift and reach truck breakdowns across all sites.",
    "Inventory Resilience": "Fewer stock-outs through safety stock and second suppliers.",
    "Month-end Close": "Close the books faster with a shared checklist.",
}
_LAYOUT_NAMES = {
    "table": "{module}: all records",
    "grid": "{module} at a glance",
    "gallery": "{module} cards",
}


def board_kind(board: Mapping[str, Any]) -> str:
    department = board.get("department_key")
    if department is None:
        return "company"
    return f"project:{department}" if board.get("scope") == "project" else str(department)


def post_text(
    board: Mapping[str, Any], index: int, invoice_total: Decimal, paid: Decimal
) -> tuple[str, str]:
    """Title and body for a Board's post at one position in its life cycle."""
    if board_kind(board) == "finance" and index == 0:
        due = invoice_total - paid
        return (
            "Partially paid invoice needs follow-up",
            f"Invoice total is ₱{invoice_total:,.2f} and the linked payment is ₱{paid:,.2f}, "
            f"so ₱{due:,.2f} is still outstanding. Review the invoice and payment together "
            "before month-end close.",
        )
    title, body = POSTS[board_kind(board)][index]
    return title[:100], body[:2000]


def revised_post(title: str, body: str) -> tuple[str, str]:
    """A small, realistic edit made after a post was first published."""
    return f"{title} (updated)"[:100], f"{body} Updated: details confirmed with the team."[:2000]


def project_board(name: str) -> tuple[str, str]:
    return name, _BOARD_DESCRIPTIONS[name]


def _module_label(module_key: str) -> str:
    text = module_key.replace("_", " ")
    return text[:1].upper() + text[1:]


def view_name(module_key: str, layout: str) -> str:
    return _LAYOUT_NAMES[layout].format(module=_module_label(module_key))


def dashboard_name(department_name: str) -> str:
    return f"{department_name} overview"


def report_names(module_key: str, cadence: str, group_name: str | None) -> tuple[str, str]:
    title = f"{cadence.title()} {_module_label(module_key).lower()} summary"
    subtitle = f"Grouped by {group_name.lower()}" if group_name else "All records with row count"
    return title, subtitle
