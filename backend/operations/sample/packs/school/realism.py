"""School's rates for the shared realism rules: an independent school in England."""

from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache

from operations.sample.realism import AmountShape, easter_sunday, nth_weekday

# R1. Most records sit in the module's normal end state; the rest form a long tail.
STATUS_WEIGHTS: dict[str, dict[str, float]] = {
    "admission_inquiries": {
        "Applied": 56, "Contacted": 14, "No response": 11, "Toured": 9, "Not interested": 6,
        "New": 4,
    },
    "applications": {
        "Enrolled": 58, "Decision released": 11, "Declined offer": 8, "Withdrawn": 6,
        "Testing and interview": 6, "Complete": 4, "Submitted": 4, "Enrolment in process": 2,
        "Started": 1,
    },
    "students": {
        "Enrolled": 86, "Incoming": 5, "On leave": 3, "Withdrawn": 3, "Transferred out": 2,
        "Graduated": 1,
    },
    "attendance_exceptions": {"Verified": 61, "Explained": 21, "Unexplained": 12, "Amended": 6},
    "courses": {"Active": 82, "Proposed": 10, "Retired": 8},
    "class_sections": {
        "Posted": 64, "Approved": 15, "Submitted": 10, "Open": 7, "Returned for correction": 4,
    },
    "assessments": {
        "Returned": 52, "Marked": 17, "Collected": 10, "Assigned": 9, "Planned": 7,
        "Rescheduled": 3, "Cancelled": 2,
    },
    "report_card_batches": {
        "Released": 56, "Principal sign-off": 13, "Adviser review": 11, "Conference follow-up": 9,
        "Collecting grades": 7, "Held": 4,
    },
    "academic_alerts": {
        "Resolved": 54, "Intervention": 16, "Parent notified": 14, "Raised": 10,
        "Escalated to guidance": 6,
    },
    "grade_change_requests": {
        "Registrar posted": 58, "Principal approved": 18, "Submitted": 14, "Rejected": 10,
    },
    "behaviour_incidents": {
        "Closed": 55, "Parent informed": 15, "Action assigned": 11, "Under investigation": 8,
        "Reported": 6, "Unfounded": 3, "Appealed": 2,
    },
    "guidance_cases": {
        "Closed": 64, "Monitoring": 12, "Active": 10, "Intake": 6, "Referred": 4,
        "Referred externally": 4,
    },
    "parent_contacts": {
        "Done": 62, "Contacted": 15, "Follow-up due": 10, "To contact": 8, "Unreachable": 5,
    },
    "activities": {"Active": 64, "Approved": 14, "Proposed": 10, "Suspended": 7, "Dissolved": 5},
    "clinic_visits": {"Closed": 66, "Parent informed": 20, "Disposed": 10, "Open": 4},
    "health_alerts": {"Active": 64, "Archived": 16, "Pending documents": 12, "Expired": 8},
    "fee_items": {"Board approved": 80, "Draft": 12, "Discontinued": 8},
    "payments": {"Reconciled": 74, "Deposited": 13, "Recorded": 9, "Bounced": 3, "Voided": 1},
    "fee_adjustments": {
        "Applied": 56, "Approved": 15, "Under review": 11, "Requested": 8, "Declined": 7,
        "Revoked": 3,
    },
    "collection_cases": {
        "Settled": 58, "Promise to pay": 14, "Open": 11, "Broken promise": 8, "Written off": 5,
        "Withdrawn pupil": 4,
    },
    "rooms": {"Available": 86, "Under repair": 9, "Closed": 5},
    "maintenance_requests": {
        "Closed": 58, "Completed": 14, "In progress": 9, "Assigned": 7, "New": 5, "On hold": 3,
        "Rejected": 2, "Duplicate": 2,
    },
    "staff_leave": {
        "HR recorded": 62, "Supervisor approved": 16, "Filed": 10, "Declined": 7, "Cancelled": 5,
    },
}  # fmt: skip

# R2. Fees follow the school's fee schedule: round tiers for each year group (GBP a term).
FEE_TIERS = (7_000, 7_500, 8_000, 9_000, 9_500, 10_000)
BURSARY_SHARE = 0.22  # Most pupils have no adjustment.
BURSARY = AmountShape(600, sigma=0.9, round_share=0.45)
ADJUSTMENT = AmountShape(450, sigma=0.9, round_share=0.3)

# Amounts that the school computes from others: what is due, the balance, and what was paid.
COMPUTED_AMOUNTS = frozenset({
    "fee_assessments.net_due", "fee_assessments.balance", "fee_assessments.adjustments_total",
    "payments.amount", "collection_cases.amount_overdue",
})  # fmt: skip
# Amounts from a fixed schedule: round numbers, but no long tail.
TIERED_AMOUNTS = frozenset({"fee_assessments.gross_fees", "fee_items.amount"})
# Numbers whose names look like money but are not: credit hours and a percentage.
NOT_AMOUNTS = frozenset({"courses.credits", "fee_adjustments.value"})
# One pupil per attendance row, and one assessment per payment slot.
STRUCTURAL_LINKS = frozenset({"student_attendance", "fee_payments"})


def england_holidays(year: int) -> set[date]:
    """Bank holidays in England, plus the days the school closes over Christmas."""
    easter = easter_sunday(year)
    return {
        date(year, 1, 1),
        easter - timedelta(days=2),  # Good Friday
        easter + timedelta(days=1),  # Easter Monday
        nth_weekday(year, 5, 0, 1),  # Early May bank holiday
        nth_weekday(year, 5, 0, -1),  # Spring bank holiday
        nth_weekday(year, 8, 0, -1),  # Summer bank holiday
        *(date(year, 12, day) for day in range(24, 32)),
    }


@lru_cache(maxsize=8)
def holidays(anchor: date) -> frozenset[date]:
    return frozenset().union(*(england_holidays(anchor.year + offset) for offset in (-1, 0, 1)))


# R9. Every department board has a Kanban whose stages fit the department's work.
BOARD_STAGES: dict[str, tuple[str, ...]] = {
    "admissions": ("Inquiry", "Tour booked", "Assessment", "Offer", "Enrolled"),
    "academic": ("Planning", "In progress", "Marking", "Moderation", "Published"),
    "student_affairs": ("Raised", "Following up", "Meeting set", "Resolved"),
    "health": ("To review", "Waiting on parents", "Plan in place", "Closed"),
    "finance": ("To invoice", "Chasing", "Payment plan", "Settled"),
    "facilities": ("Reported", "Assigned", "In progress", "Signed off"),
    "hr": ("Draft", "Approval", "Scheduled", "Done"),
}
BOARD_OBJECTIVES: dict[str, tuple[str, ...]] = {
    "admissions": ("Plan the open morning", "Update the prospectus", "Call waiting-list families",
                   "Book the entrance assessment rooms", "Send offer letters",
                   "Review sibling priority"),
    "academic": ("Write the Year 9 options booklet", "Moderate the mock papers",
                 "Plan the reading week", "Review the homework policy",
                 "Book the science technician cover", "Update the scheme of work"),
    "student_affairs": ("Plan the anti-bullying week", "Review the behaviour log",
                        "Book the guidance workshops", "Update the house points",
                        "Organise the school council election"),
    "health": ("Renew the first-aid certificates", "Update the allergy list",
               "Check the defibrillator pads", "Send the flu consent forms",
               "Restock the medical room"),
    "finance": ("Send the term fee reminders", "Reconcile the trip payments",
                "Review bursary applications", "Close the summer term accounts",
                "Update the fee schedule"),
    "facilities": ("Service the boilers", "Repaint the sports hall lines", "Check the fire doors",
                   "Clear the gutters before winter", "Replace the library lights"),
    "hr": ("Run the DBS renewals", "Plan the INSET day", "Update the staff handbook",
           "Book the safeguarding training", "Review supply cover costs"),
}  # fmt: skip
