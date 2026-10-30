"""Foundation statuses and relationship rules, planned from record indexes and counts only.

A record's status that a link depends on (an awarded grant, a released advance, a request
that became an order) comes from the same seed-free rules here, so both sides agree.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.nonprofit import vocabulary
from operations.sample.packs.nonprofit.catalog_fields import AWARDED, ORG_ROLES
from operations.sample.packs.nonprofit.realism import (
    LATEST_RESULT,
    OLDER_RESULT,
    OPEN_REQUEST,
    STATUS_WEIGHTS,
)
from operations.sample.realism import skewed_parent, weighted_label

# Records below this index carry named business cases; the realism rules leave them alone.
PINNED = 10
REFERENCE_FIELDS: tuple[tuple[str, str], ...] = ()

# The named follow-ups: Fund 1 for the newly awarded Grant 3, and Feedback Case 1 for the
# disputed distribution on Assistance 5.
FUNDED_GRANT = 2
DISPUTED_ASSISTANCE = 4

_PINNED_STATUS: dict[tuple[str, int], str] = {
    ("campaigns", 1): "Active",
    ("pledges", 0): "In progress",
    ("grant_awards", FUNDED_GRANT): AWARDED,
    ("grant_awards", 3): "Under donor review",  # The live input awards it.
    ("assistance", 3): "Delivered",  # The live input marks it disputed.
    ("assistance", DISPUTED_ASSISTANCE): "Disputed",
    ("beneficiaries", 5): "Pending consent",
    ("feedback_cases", 0): "Under review",
    ("feedback_cases", 1): "Escalated",
    ("cash_advances", 0): "Partially liquidated",
    ("cash_advances", 3): "Partially liquidated",
    ("purchase_requests", 0): "Submitted",
}
AWARDED_STAGES = frozenset({AWARDED, "Active", "Closing", "Closed"})
RELEASED = frozenset({"Released", "Partially liquidated", "Fully liquidated", "Closed",
                      "Overdue", "Refund due"})  # fmt: skip
type Counts = tuple[tuple[str, int], ...]


def rng(*parts: object) -> random.Random:
    return random.Random(":".join(("fcdf", *map(str, parts))))


def pick(key: str, child: int, pool: tuple[int, ...]) -> int:
    return pool[skewed_parent(key, child, len(pool))]


def _frozen(counts: Mapping[str, int]) -> Counts:
    return tuple(sorted(counts.items()))


def status(module_key: str, index: int, counts: Mapping[str, int]) -> str:
    return _status(module_key, index, _frozen(counts))


@lru_cache(maxsize=262_144)
def _status(module_key: str, index: int, frozen: Counts) -> str:
    counts = dict(frozen)
    pinned = _PINNED_STATUS.get((module_key, index))
    if pinned is not None:
        return pinned
    derived = _derived_status(module_key, index, counts)
    if derived is not None:
        return derived
    weights = STATUS_WEIGHTS[module_key]
    if index < PINNED:
        return next(iter(weights))
    return weighted_label(rng(module_key, index, "status"), weights)


def _derived_status(module_key: str, index: int, counts: dict[str, int]) -> str | None:
    from operations.sample.packs.nonprofit import links_finance as finance

    if module_key == "indicator_results":
        rank = result_slot(index, counts)[1]
        return weighted_label(rng(module_key, index, "status"),
                              LATEST_RESULT if rank == 0 else OLDER_RESULT)  # fmt: skip
    if module_key == "purchase_requests":
        ordered = finance.ordered_requests(counts["purchase_requests"], counts["purchase_orders"])
        if finance.request_converted(index) and index in ordered:
            return "Completed" if rng(module_key, index, "po").random() < 0.88 else "PO issued"
        if finance.request_converted(index):
            return "Approved"
        return weighted_label(rng(module_key, index, "status"), OPEN_REQUEST)
    if module_key == "purchase_orders":
        request = finance.order_request(index, counts)
        done = request is not None and status("purchase_requests", request, counts) == "Completed"
        weights = ({"Closed": 70, "Paid": 16, "Received": 12, "Cancelled": 2} if done
                   else {"Issued": 55, "Partially received": 30, "Received": 15})  # fmt: skip
        return weighted_label(rng(module_key, index, "status"), weights)
    if module_key == "disbursements":
        kind = finance.disbursement_kind(index, counts)[0]
        weights = {
            "advance": {"Cleared": 92, "Released": 8},
            "order": {"Cleared": 85, "Released": 8, "Approved": 4, "For approval": 3},
        }.get(kind, {"Cleared": 60, "Released": 10, "For approval": 10, "Draft": 8,
                     "Approved": 6, "On hold": 3, "Voided": 3})  # fmt: skip
        return weighted_label(rng(module_key, index, "status"), weights)
    if module_key == "expense_lines":
        advance = finance.expense_advance(index, counts)
        if advance is None:
            return None
        state = status("cash_advances", advance, counts)
        if state in {"Closed", "Fully liquidated", "Refund due"}:
            return "Posted"
        return ("Checked", "Submitted", "Approved")[index % 3]
    if module_key == "funds":
        grant = fund_grant(index, counts)
        if grant is None:
            return None
        stage = status("grant_awards", grant, counts)
        return {AWARDED: "Open", "Closed": "Closed",
                "Closing": ("Active", "Fully spent")[index % 2]}.get(stage, "Active")  # fmt: skip
    if module_key == "budget_lines":
        stage = status("grant_awards", budget_line_grant(index, counts), counts)
        if stage == "Closed":
            return "Closed"
        return "Frozen" if index >= PINNED and index % 25 == 7 else "Open"
    return None


@lru_cache(maxsize=64)
def _matching(
    module_key: str, total: int, labels: frozenset[str], extra: Counts
) -> tuple[int, ...]:
    counts = {module_key: total, **dict(extra)}
    return tuple(item for item in range(total) if status(module_key, item, counts) in labels)


def where(module_key: str, counts: Mapping[str, int], labels: frozenset[str]) -> tuple[int, ...]:
    return _matching(module_key, counts[module_key], labels, _frozen(counts))


# Resource Mobilization: givers, campaigns and the pledge payment schedule.


def giving_donors(counts: Mapping[str, int]) -> tuple[int, ...]:
    labels = frozenset(STATUS_WEIGHTS["donors"]) - {"Prospect"}
    return where("donors", counts, labels) or tuple(range(counts["donors"]))


def live_campaigns(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("campaigns", counts, frozenset({"Active", "Closed"})) or (0,)


def installments(pledge: int, counts: Mapping[str, int]) -> int:
    if pledge == 0:
        return 4
    if pledge == 1:
        return 1
    count = rng("pledges", pledge, "installments").choice((1, 2, 3, 4, 4, 4, 6, 12))
    if count == 1 and status("pledges", pledge, counts) in {"In progress", "Overdue",
                                                             "Written off"}:  # fmt: skip
        return 4
    return count


def frequency(count: int) -> str:
    return "Monthly" if count >= 6 else {1: "Annual", 2: "Semiannual"}.get(count, "Quarterly")


def paid_count(pledge: int, counts: Mapping[str, int]) -> int:
    if pledge == 0:
        return 1
    total = installments(pledge, counts)
    state = status("pledges", pledge, counts)
    if state == "Completed":
        return total
    if state in {"In progress", "Overdue", "Written off"}:
        return rng("pledges", pledge, "paid").randint(1, total - 1)
    return 0


@lru_cache(maxsize=16)
def _pledge_slots(pledges: int, donations: int) -> tuple[tuple[int, int], ...]:
    counts = {"pledges": pledges}
    slots = [(pledge, step) for pledge in range(pledges) for step in range(paid_count(pledge,
                                                                                    counts))]
    return tuple(slots[:donations])


def pledge_slot(donation: int, counts: Mapping[str, int]) -> tuple[int, int] | None:
    slots = _pledge_slots(counts["pledges"], counts["donations"])
    return slots[donation] if donation < len(slots) else None


def paid_installments(pledge: int, counts: Mapping[str, int]) -> int:
    """Installments that have a Donation record (all of them, unless the run is tiny)."""
    slots = _pledge_slots(counts["pledges"], counts["donations"])
    return sum(1 for owner, _step in slots if owner == pledge)


def pledge_donor(pledge: int, counts: Mapping[str, int]) -> int:
    return pick("donor_pledges", pledge, giving_donors(counts))


def pledge_campaign(pledge: int, counts: Mapping[str, int]) -> int:
    return pick("campaign_pledges", pledge, live_campaigns(counts))


def donation_donor(donation: int, counts: Mapping[str, int]) -> int:
    slot = pledge_slot(donation, counts)
    if slot is not None:
        return pledge_donor(slot[0], counts)
    return pick("donor_donations", donation, giving_donors(counts))


def donation_campaign(donation: int, counts: Mapping[str, int]) -> int | None:
    slot = pledge_slot(donation, counts)
    if slot is not None:
        return pledge_campaign(slot[0], counts)
    if donation >= PINNED and rng("donations", donation, "campaign").random() < 0.15:
        return None  # General online giving, outside any campaign.
    return pick("campaign_donations", donation, live_campaigns(counts))


# Grants and Partnerships: funders, awarded grants and their lines, reports and funds.


def org_role(organization: int) -> str:
    if organization < len(vocabulary.FUNDERS):
        return vocabulary.FUNDERS[organization][2]
    return weighted_label(rng("organizations", organization, "role"),
                          dict(zip(ORG_ROLES, (30, 12, 40, 18), strict=True)))  # fmt: skip


def grant_funder(grant: int, _counts: Mapping[str, int] | None = None) -> int:
    """Grants come from the named funders; the large ones fund several."""
    funders = len(vocabulary.FUNDERS)
    if grant < funders:
        return grant
    weights = [(rank + 1) ** -0.7 for rank in range(funders)]
    return rng("grant_awards", grant, "funder").choices(range(funders), weights=weights)[0]


def donor_type(donor: int) -> str:
    weights = {"Individual": 82, "Household": 8, "Anonymous": 7, "Staff or board": 3}
    return weighted_label(rng("donors", donor, "type"), weights)


def awarded_grants(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("grant_awards", counts, AWARDED_STAGES) or (0,)


def budget_line_grant(line: int, counts: Mapping[str, int]) -> int:
    return pick("grant_budget_lines", line, awarded_grants(counts))


def report_grant(report: int, counts: Mapping[str, int]) -> int:
    return pick("grant_report_schedule", report, awarded_grants(counts))


def _funded_order(counts: Mapping[str, int]) -> tuple[int, ...]:
    awarded = awarded_grants(counts)
    first = (FUNDED_GRANT,) if FUNDED_GRANT in awarded else ()
    order = (*first, *(grant for grant in awarded if grant != FUNDED_GRANT))
    funds = counts["funds"]
    return order[: max(0, funds - max(1, funds // 6))]


def fund_grant(fund: int, counts: Mapping[str, int]) -> int | None:
    order = _funded_order(counts)
    return order[fund] if fund < len(order) else None


def grant_fund(grant: int, counts: Mapping[str, int]) -> int | None:
    order = _funded_order(counts)
    return order.index(grant) if grant in order else None


def open_budget_lines(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("budget_lines", counts, frozenset({"Open"})) or (0,)


# Programs: projects, their sites, activities, people and the help they received.

ACTIVE_PROJECT = frozenset({"Implementation", "Finalisation", "Closed"})
SERVED = frozenset({"Active", "Exited", "Verified"})
_DELIVERY_ACTIVITIES = frozenset({"Distribution", "Training", "Tutoring session"})


def project_grants(project: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    awarded = awarded_grants(counts)
    first = awarded[project % len(awarded)]
    if project % 3 == 2 and len(awarded) > 1:
        return (first, awarded[(project + 1) % len(awarded)])
    return (first,)


def active_projects(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("projects", counts, ACTIVE_PROJECT) or (0,)


def site_projects(site: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    projects = counts["projects"]
    first = site % projects
    if site % 4 == 1 and projects > 1:
        return (first, (site + 1) % projects)
    return (first,)


@lru_cache(maxsize=16)
def _project_sites(sites: int, projects: int, frozen: Counts) -> dict[int, tuple[int, ...]]:
    counts = dict(frozen)
    found: dict[int, list[int]] = {}
    for site in range(sites):
        if status("sites", site, counts) != "Active":
            continue
        for project in site_projects(site, counts):
            found.setdefault(project, []).append(site)
    return {project: tuple(items) for project, items in found.items()}


def project_sites(project: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _project_sites(counts["sites"], counts["projects"], _frozen(counts)).get(project, ())


def activity_type(activity: int) -> str:
    if activity < PINNED:
        return ("Distribution", "Training")[activity % 2]
    weights = {"Distribution": 26, "Training": 20, "Tutoring session": 16,
               "Community meeting": 12, "Monitoring visit": 10, "Assessment": 7,
               "Coordination meeting": 5, "Drill": 4}  # fmt: skip
    return weighted_label(rng("activities", activity, "type"), weights)


def activity_project(activity: int, counts: Mapping[str, int]) -> int:
    return pick("project_activities", activity, active_projects(counts))


def activity_site(activity: int, counts: Mapping[str, int]) -> int | None:
    sites = project_sites(activity_project(activity, counts), counts)
    return sites[(activity * 7) % len(sites)] if sites else None


@lru_cache(maxsize=16)
def _delivery_activities(frozen: Counts) -> dict[int, tuple[int, ...]]:
    counts = dict(frozen)
    found: dict[int, list[int]] = {}
    for activity in range(counts["activities"]):
        if (status("activities", activity, counts) == "Completed"
                and activity_type(activity) in _DELIVERY_ACTIVITIES):  # fmt: skip
            found.setdefault(activity_project(activity, counts), []).append(activity)
    return {project: tuple(items) for project, items in found.items()}


def _active_sites(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("sites", counts, frozenset({"Active"})) or (0,)


def beneficiary_site(beneficiary: int, counts: Mapping[str, int]) -> int:
    return pick("site_beneficiaries", beneficiary, _active_sites(counts))


def beneficiary_projects(beneficiary: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    projects = site_projects(beneficiary_site(beneficiary, counts), counts)
    return projects if beneficiary % 5 == 0 else projects[:1]


def _served(counts: Mapping[str, int]) -> tuple[int, ...]:
    return where("beneficiaries", counts, SERVED) or (0,)


def assistance_beneficiary(item: int, counts: Mapping[str, int]) -> int:
    return pick("beneficiary_assistance", item, _served(counts))


def assistance_activity(item: int, counts: Mapping[str, int]) -> int | None:
    project = beneficiary_projects(assistance_beneficiary(item, counts), counts)[0]
    candidates = _delivery_activities(_frozen(counts)).get(project, ())
    return candidates[(item * 5) % len(candidates)] if candidates else None


def assistance_project(item: int, counts: Mapping[str, int]) -> int:
    return beneficiary_projects(assistance_beneficiary(item, counts), counts)[0]


# MEAL: indicators of each project and their reporting periods.

PERIODS = {"Monthly": 11, "Quarterly": 3, "Semiannual": 1, "Annual": 1, "Endline": 0}


def indicator_frequency(indicator: int) -> str:
    if indicator < PINNED:
        return ("Quarterly", "Monthly")[indicator % 2]
    weights = {"Quarterly": 50, "Monthly": 30, "Semiannual": 8, "Annual": 7, "Endline": 5}
    return weighted_label(rng("indicators", indicator, "frequency"), weights)


def indicator_project(indicator: int, counts: Mapping[str, int]) -> int:
    return indicator % counts["projects"]


@lru_cache(maxsize=16)
def _result_slots(frozen: Counts) -> tuple[tuple[int, int], ...]:
    counts = dict(frozen)
    reporting = [
        indicator for indicator in range(counts["indicators"])
        if status("indicators", indicator, counts) in {"Active", "Approved"}
        and PERIODS[indicator_frequency(indicator)]
    ] or [0]  # fmt: skip
    return tuple(
        (indicator, rank)
        for rank in range(max(PERIODS.values()))
        for indicator in reporting
        if rank < max(1, PERIODS[indicator_frequency(indicator)])
    )


def result_slot(result: int, counts: Mapping[str, int]) -> tuple[int, int]:
    keep = {key: counts[key] for key in ("indicators", "projects")}
    slots = _result_slots(_frozen(keep))
    return slots[result % len(slots)]

