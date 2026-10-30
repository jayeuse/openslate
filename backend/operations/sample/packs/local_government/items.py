"""What the city buys and who sells it: each request's item, office and supplier kind."""

from __future__ import annotations

import random

from operations.sample.packs.local_government import vocabulary
from operations.sample.packs.local_government.links import PINNED

_SIGNS_BY_TYPE = (
    (("Builders", "Construction", "Asphalt", "Concrete", "Sand and Gravel"),
     "Infrastructure contractor"),
    (("Consultants",), "Consulting"),
    (("Services", "Agency", "Catering", "Trucking", "Telecom", "Motor Works"), "Service provider"),
)  # fmt: skip


def item(request: int) -> tuple[str, str, str, int]:
    """The item, the end-user office, the kind of supplier, and the item's usual budget."""
    items = vocabulary.PROCUREMENT_ITEMS
    if request < PINNED:
        return items[request % len(items)]
    return items[random.Random(f"lg:item:{request}").randrange(len(items))]


def supplier_name(index: int) -> str:
    names = vocabulary.SUPPLIERS
    if index < len(names):
        return names[index]
    places = vocabulary.BRANCH_PLACES
    return f"{names[index % len(names)]}, {places[(index // len(names)) % len(places)]}"


def supplier_type(supplier: int) -> str:
    name = supplier_name(supplier)
    for words, label in _SIGNS_BY_TYPE:
        if any(word in name for word in words):
            return label
    return "Goods"
