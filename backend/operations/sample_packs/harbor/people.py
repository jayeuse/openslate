"""Harbor's user roster and per-group Access grants."""

from __future__ import annotations

from operations.sample_packs.harbor.vocabulary import (
    GUEST_DOMAINS,
    INTERNAL_DOMAIN,
    TEAM_ROSTER,
    TEAM_TITLES,
)
from operations.sample_packs.types import PersonSpec

DEPARTMENT_KEYS = ("sales", "service", "field", "inventory", "purchasing", "finance")
MODULE_KEYS = ("inspections", "products", "purchase_orders", "invoices")
TEAM_GROUPS = {
    "sales": "sales-desk",
    "service": "service-triage",
    "field": "field-operations",
    "inventory": "inventory-control",
    "purchasing": "purchasing-review",
    "finance": "finance-review",
}
GROUP_ACCESS: dict[str, tuple[tuple[str, str | None, str], ...]] = {
    "harbor-operations": tuple((key, None, "manage") for key in DEPARTMENT_KEYS),
    "sales-desk": (("sales", None, "manage"),),
    "service-triage": (("service", None, "manage"),),
    "field-operations": (("field", None, "write"), ("field", "inspections", "manage")),
    "inventory-control": (("inventory", None, "write"), ("inventory", "products", "manage")),
    "purchasing-review": (("purchasing", None, "write"),),
    "finance-review": (("finance", None, "write"),),
    "internal-audit": (("finance", None, "read"), ("purchasing", None, "read")),
    "guest-readers": tuple((key, None, "manage") for key in DEPARTMENT_KEYS),
}


def _identity(name: str, domain: str = INTERNAL_DOMAIN) -> tuple[str, str]:
    first, *rest = name.lower().split()
    last = "".join(rest)
    return f"{first}.{last}@{domain}", f"{first}_{last}"


def people() -> tuple[PersonSpec, ...]:
    result: list[PersonSpec] = []
    for team, members in TEAM_ROSTER.items():
        for index, name in enumerate(members):
            suffix = "lead" if index == 0 else f"{index + 1:02d}"
            actor: str | None = team if index == 0 else None
            email, username = _identity(name)
            groups: tuple[str, ...] = (TEAM_GROUPS[team],)
            if actor:
                groups += ("harbor-operations",)
            if team == "sales" and index in {3, 4}:
                groups += ("internal-audit",)
            result.append(
                PersonSpec(
                    key=f"internal_{team}_{suffix}",
                    email=email,
                    username=username,
                    name=name,
                    title=TEAM_TITLES[team][index],
                    role="member",
                    status="active",
                    groups=groups,
                    actor=actor,
                )
            )

    pending = (
        ("sales", "Taylor James", "Sales Associate"),
        ("service", "Jamie Ortega", "Support Associate"),
        ("inventory", "Robin Lee", "Stock Associate"),
        ("finance", "Alex Perez", "Billing Associate"),
    )
    for index, (team, name, title) in enumerate(pending, start=1):
        result.append(
            PersonSpec(
                f"internal_pending_{index:02d}",
                *_identity(name),
                name,
                title,
                "member",
                "pending",
                (TEAM_GROUPS[team],),
            )
        )

    for key, name, title in (
        ("internal_disabled_01", "Morgan Ellis", "Former Sales Coordinator"),
        ("internal_disabled_02", "Casey Flores", "Former Field Technician"),
    ):
        result.append(
            PersonSpec(
                key,
                *_identity(name),
                name,
                title,
                "member",
                "disabled",
            )
        )

    guests = (
        ("01", "Amara Cole", "Customer Auditor", "active"),
        ("02", "Ben Ito", "Supplier Reviewer", "active"),
        ("03", "Cora Mills", "Project Observer", "active"),
        ("04", "Drew Kim", "Service Partner", "active"),
        ("05", "Eden Park", "External Analyst", "active"),
        ("06", "Finn Blake", "Delivery Partner", "active"),
        ("07", "Gray Patel", "Prospective Partner", "pending"),
        ("08", "Harper Young", "Former External Reviewer", "disabled"),
    )
    for suffix, name, title, status in guests:
        result.append(
            PersonSpec(
                f"guest_{suffix}",
                *_identity(name, GUEST_DOMAINS[int(suffix) % len(GUEST_DOMAINS)]),
                name,
                title,
                "guest",
                status,
                ("guest-readers",),
                sponsor="internal_sales_lead",
            )
        )
    if len(result) != 44:
        raise ValueError("The people catalogue must contain 44 identities")
    return tuple(result)
