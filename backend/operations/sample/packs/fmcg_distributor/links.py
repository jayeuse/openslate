"""Distributor relationship rules, planned from record indexes and counts only.

A status that a link depends on (a delivered order, a received purchase order) is drawn
here by the same index rule, so both ends always agree. Dates and money follow the links.
"""

from __future__ import annotations

import random
from bisect import bisect_left
from collections.abc import Callable, Mapping
from functools import lru_cache
from itertools import accumulate

from operations.sample.packs.fmcg_distributor.realism import STATUS_WEIGHTS
from operations.sample.realism import pareto_weights, weighted_label

# Records below this index carry named business cases; the realism rules leave them alone.
PINNED = 10
SPAN = 91  # One quarter of distribution work (plan: span).

# The named follow-ups: a short-delivery claim after receipt 5, a call after invoice 5.
DISCREPANCY_RECEIPT = 4
FOLLOWED_INVOICE = 4

# Typed codes that repeat a link the department already has as a relationship.
REFERENCE_FIELDS: tuple[tuple[str, str], ...] = ()

_PINNED_STATUS: dict[tuple[str, int], str] = {
    ("goods_receipts", 2): "Counting",  # The live input posts it with a discrepancy.
    ("goods_receipts", DISCREPANCY_RECEIPT): "Posted with discrepancy",
    ("stock_counts", 1): "Recount required",
    ("trade_promotions", 1): "Claimed",
    ("principal_invoices", 1): "On hold – variance",
    ("credit_reviews", 0): "Submitted",
    ("principal_claims", 0): "Submitted",
    ("returns", 1): "Credited",
    ("purchase_orders", 1): "Pending approval",
}


def rng(*parts: object) -> random.Random:
    return random.Random("fmcg:" + ":".join(str(part) for part in parts))


def status(module_key: str, index: int) -> str:
    """The drawn status of a module whose status no other record decides."""
    pinned = _PINNED_STATUS.get((module_key, index))
    if pinned is not None:
        return pinned
    weights = STATUS_WEIGHTS[module_key]
    if index < PINNED:
        return next(iter(weights))
    return weighted_label(rng(module_key, index, "status"), weights)


_TABLES: dict[tuple[object, ...], tuple[tuple[int, ...], tuple[float, ...]]] = {}


def pick(
    key: str, child: int, size: tuple[int, ...], eligible: Callable[[], tuple[int, ...]],
    alpha: float = 0.8,
) -> int:  # fmt: skip
    """A Pareto-weighted parent: a few parents get many children and the tail gets few."""
    table_key = (key, size, alpha)
    if table_key not in _TABLES:
        items = eligible()
        if not items:
            raise ValueError(f"No eligible parent for {key}")
        weights = pareto_weights(rng("table", key, *size), [str(item) for item in items], alpha)
        _TABLES[table_key] = (items, tuple(accumulate(weights)))
    items, cumulative = _TABLES[table_key]
    return items[bisect_left(cumulative, rng(key, child).random() * cumulative[-1])]


def fill(size: int, total: int, desired: Callable[[int], int]) -> tuple[int, ...]:
    """Start offsets of each parent's children: every parent gets at least one, and the
    rest follow each parent's desired size (pinned parents keep theirs exactly)."""
    fixed = {index: desired(index) for index in range(min(size, PINNED))}
    rest = [index for index in range(size) if index not in fixed]
    spare = total - sum(fixed.values()) - len(rest)
    if spare < 0:
        raise ValueError("Too few child records for the parents that need them")
    weights = [max(0, desired(index) - 1) for index in rest]
    scale = sum(weights) or 1
    sizes = dict(fixed)
    running = 0
    for index, weight in zip(rest, weights, strict=True):
        before = running * spare // scale
        running += weight
        sizes[index] = 1 + running * spare // scale - before
    if not rest and spare:
        sizes[size - 1] += spare
    return tuple(accumulate((sizes[index] for index in range(size)), initial=0))


def owner(starts: tuple[int, ...], child: int) -> int:
    return bisect_left(starts, child + 1) - 1


def _key(counts: Mapping[str, int], *modules: str) -> tuple[int, ...]:
    return tuple(counts[module] for module in modules)


# Purchasing: principals and their products.


def principal_status(principal: int) -> str:
    if principal % 12 == 11:
        return "Onboarding"
    if principal >= 12 and principal % 12 == 5:
        return "On hold"
    if principal >= 24 and principal % 12 == 8:
        return "Terminated"
    return "Active"


def _principals(total: int, allowed: frozenset[str]) -> tuple[int, ...]:
    return tuple(item for item in range(total) if principal_status(item) in allowed)


def product_principal(product: int, counts: Mapping[str, int]) -> int:
    total = counts["principals"]
    if product < PINNED:
        supplying = _principals(total, frozenset({"Active"}))
        return supplying[(0, 0, 0, 5, 3, 1, 2, 9, 4, 6)[product] % len(supplying)]
    return pick("principal_products", product, (total,),
                lambda: _principals(total, frozenset({"Active", "On hold", "Terminated"})),
                alpha=0.35)  # fmt: skip


@lru_cache(maxsize=16)
def _principal_products(principals: int, products: int) -> dict[int, tuple[int, ...]]:
    counts = {"principals": principals, "products": products}
    found: dict[int, list[int]] = {}
    for product in range(products):
        found.setdefault(product_principal(product, counts), []).append(product)
    return {key: tuple(value) for key, value in found.items()}


def principal_products(principal: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _principal_products(*_key(counts, "principals", "products")).get(principal, ())


def product_rank(product: int, counts: Mapping[str, int]) -> int:
    """The product's position in its principal's list, which names its item and pack."""
    return principal_products(product_principal(product, counts), counts).index(product)


def product_status(product: int) -> str:
    return status("products", product)


def _sellable(products: int) -> tuple[int, ...]:
    return tuple(item for item in range(products)
                 if product_status(item) in {"Active", "Phase-out", "New listing"})  # fmt: skip


def popular_product(key: str, child: int, counts: Mapping[str, int]) -> int:
    return pick(key, child, (counts["products"],), lambda: _sellable(counts["products"]), 0.9)


# Sales: beats, outlets, visits, orders and lines.


def beat_status(beat: int) -> str:
    return {3: "Under review", 7: "Draft", 11: "Retired"}.get(beat % 12, "Active")


def beat_route(beat: int) -> str:
    if beat % 10 in {2, 5, 8}:
        return "Van sales"
    return "Key account" if beat % 10 == 9 else "Pre-sell"


def _beats(total: int, route: str) -> tuple[int, ...]:
    working = [item for item in range(total) if beat_status(item) in {"Active", "Under review"}]
    matched = tuple(item for item in working if beat_route(item) == route)
    return matched or tuple(working)


def outlet_status(outlet: int) -> str:
    return "Active" if outlet < PINNED else status("outlets", outlet)


_PINNED_CHANNELS = ("Minimart", "Wholesaler or market stall", "Sari-sari store", "Small grocery",
                    "Pharmacy or drugstore")  # fmt: skip
_CHANNEL_WEIGHTS = {"Sari-sari store": 60, "Small grocery": 12, "Pharmacy or drugstore": 8,
                    "Minimart": 7, "Wholesaler or market stall": 6, "Carinderia": 5,
                    "Supermarket (modern trade)": 2}  # fmt: skip


def outlet_channel(outlet: int) -> str:
    if outlet < len(_PINNED_CHANNELS):
        return _PINNED_CHANNELS[outlet]
    if outlet < PINNED:
        return "Sari-sari store"
    return weighted_label(rng("outlets", outlet, "channel"), _CHANNEL_WEIGHTS)


def outlet_beat(outlet: int, counts: Mapping[str, int]) -> int | None:
    total = counts["beats"]
    if outlet_status(outlet) == "Prospect":
        return None
    channel = outlet_channel(outlet)
    route = "Key account" if channel == "Supermarket (modern trade)" else (
        "Van sales" if outlet >= PINNED and outlet % 4 == 1 else "Pre-sell")  # fmt: skip
    beats = _beats(total, route)
    return beats[outlet % len(beats)] if outlet < PINNED else pick(
        f"beat_outlets:{route}", outlet, (total,), lambda: beats, alpha=0.4)  # fmt: skip


@lru_cache(maxsize=16)
def _outlets_by_route(beats: int, outlets: int) -> dict[str, tuple[int, ...]]:
    counts = {"beats": beats, "outlets": outlets}
    found: dict[str, list[int]] = {"Pre-sell": [], "Van sales": [], "Key account": []}
    for outlet in range(outlets):
        beat = outlet_beat(outlet, counts)
        if beat is not None and outlet_status(outlet) in {"Active", "On credit hold", "Blocked"}:
            found[beat_route(beat)].append(outlet)
    return {key: tuple(value) for key, value in found.items()}


def route_outlets(route: str, counts: Mapping[str, int]) -> tuple[int, ...]:
    found = _outlets_by_route(*_key(counts, "beats", "outlets"))
    return found[route] or found["Pre-sell"] or found["Van sales"]


def order_channel(order: int) -> str:
    if order < PINNED:
        return "Pre-sell"
    return weighted_label(rng("sales_orders", order, "channel"),
                          {"Pre-sell": 88, "Key account": 8, "Phone or chat": 4})  # fmt: skip


def order_status(order: int) -> str:
    return "Delivered" if order < PINNED else status("sales_orders", order)


@lru_cache(maxsize=16)
def presell_orders(orders: int) -> tuple[int, ...]:
    return tuple(item for item in range(orders) if order_channel(item) == "Pre-sell")


def presell_visit_count(counts: Mapping[str, int]) -> int:
    booked = len(presell_orders(counts["sales_orders"]))
    return min(counts["store_visits"], max(booked, round(booked / 0.65)))


@lru_cache(maxsize=16)
def _order_visits(orders: int, visits: int, presell: int) -> dict[int, int]:
    booked = presell_orders(orders)
    found = {}
    for rank, order in enumerate(booked):
        if rank < PINNED or len(booked) == PINNED:
            found[order] = rank
        else:
            found[order] = PINNED + (rank - PINNED) * (presell - PINNED) // (len(booked) - PINNED)
    return found


def order_visit(order: int, counts: Mapping[str, int]) -> int | None:
    key = (counts["sales_orders"], counts["store_visits"], presell_visit_count(counts))
    return _order_visits(*key).get(order)


@lru_cache(maxsize=16)
def _visit_orders(orders: int, visits: int, presell: int) -> dict[int, int]:
    return {visit: order for order, visit in _order_visits(orders, visits, presell).items()}


def visit_order(visit: int, counts: Mapping[str, int]) -> int | None:
    key = (counts["sales_orders"], counts["store_visits"], presell_visit_count(counts))
    return _visit_orders(*key).get(visit)


def visit_outlet(visit: int, counts: Mapping[str, int]) -> int:
    if visit < PINNED:
        return visit
    if visit >= presell_visit_count(counts):
        outlets = route_outlets("Van sales", counts)
        return pick("van_visits", visit, (counts["beats"], counts["outlets"]), lambda: outlets)
    outlets = (*route_outlets("Pre-sell", counts), *route_outlets("Key account", counts))
    return pick("outlet_visits", visit, (counts["beats"], counts["outlets"]), lambda: outlets)


def order_outlet(order: int, counts: Mapping[str, int]) -> int:
    visit = order_visit(order, counts)
    if visit is not None:
        return visit_outlet(visit, counts)
    if order_channel(order) == "Key account":
        outlets = route_outlets("Key account", counts)
        return pick("ka_orders", order, (counts["beats"], counts["outlets"]), lambda: outlets)
    outlets = route_outlets("Pre-sell", counts)
    return pick("outlet_orders", order, (counts["beats"], counts["outlets"]), lambda: outlets)


# Van tours: van visits and van invoices are split across the tours that went out.


def tour_status(tour: int, counts: Mapping[str, int]) -> str:
    if tour >= PINNED and tour % 12 == 11:
        return "Cancelled"
    if tour >= PINNED and tour % 24 == 17:
        return "Planned"
    if tour == 1:
        return "Variance under review"
    worked = [item for item in range(counts["route_tours"]) if item < PINNED
              or (item % 12 != 11 and item % 24 != 17)]  # fmt: skip
    if counts["route_tours"] > 3 and tour == worked[-1]:
        return "Checked in"
    if tour < PINNED:
        return "Settled"
    return weighted_label(rng("route_tours", tour, "status"),
                          {"Settled": 92, "Variance under review": 8})  # fmt: skip


@lru_cache(maxsize=16)
def _worked_tours(tours: int) -> tuple[int, ...]:
    counts = {"route_tours": tours}
    return tuple(item for item in range(tours)
                 if tour_status(item, counts) not in {"Cancelled", "Planned"})  # fmt: skip


def worked_tours(counts: Mapping[str, int]) -> tuple[int, ...]:
    return _worked_tours(counts["route_tours"])


def _split(position: int, total: int, buckets: tuple[int, ...]) -> tuple[int, int]:
    """The bucket of one item in contiguous, even chunks, and the item's place in it."""
    if total <= 0 or not buckets:
        raise ValueError("Nothing to split across the van tours")
    bucket = position * len(buckets) // total
    first = -(-bucket * total // len(buckets))
    return buckets[bucket], position - first


def visit_tour(visit: int, counts: Mapping[str, int]) -> tuple[int, int]:
    presell = presell_visit_count(counts)
    return _split(visit - presell, counts["store_visits"] - presell, worked_tours(counts))


def tour_van_visits(tour: int, counts: Mapping[str, int]) -> int:
    van = counts["store_visits"] - presell_visit_count(counts)
    tours = worked_tours(counts)
    if tour not in tours:
        return 0
    bucket = tours.index(tour)
    return -(-(bucket + 1) * van // len(tours)) - -(-bucket * van // len(tours))


# Delivery: delivered orders ride the trips in order; a failed drop goes out again.


def trip_status(trip: int) -> str:
    if trip >= PINNED and trip % 12 == 11:
        return "Cancelled"
    if trip < PINNED:
        return "Closed"
    return weighted_label(rng("delivery_trips", trip, "status"),
                          {"Closed": 90, "Returned to depot": 10})  # fmt: skip


@lru_cache(maxsize=16)
def delivered_orders(orders: int) -> tuple[int, ...]:
    return tuple(item for item in range(orders)
                 if order_status(item) in {"Delivered", "Partially delivered"})  # fmt: skip


@lru_cache(maxsize=16)
def _worked_trips(trips: int) -> tuple[int, ...]:
    return tuple(item for item in range(trips) if trip_status(item) != "Cancelled")


def _failed_first(rank: int, trip_position: int) -> bool:
    return rank >= PINNED and rank % 19 == 7 and trip_position > 0


@lru_cache(maxsize=16)
def _order_trips(orders: int, trips: int) -> dict[int, tuple[int, ...]]:
    delivered = delivered_orders(orders)
    worked = _worked_trips(trips)
    found: dict[int, tuple[int, ...]] = {}
    for rank, order in enumerate(delivered):
        position = rank * len(worked) // len(delivered)
        found[order] = ((worked[position - 1], worked[position])
                        if _failed_first(rank, position) else (worked[position],))  # fmt: skip
    return found


def order_trips(order: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _order_trips(*_key(counts, "sales_orders", "delivery_trips")).get(order, ())


@lru_cache(maxsize=16)
def _trip_orders(orders: int, trips: int) -> dict[int, tuple[int, ...]]:
    found: dict[int, list[int]] = {}
    for order, rides in _order_trips(orders, trips).items():
        for trip in rides:
            found.setdefault(trip, []).append(order)
    return {key: tuple(value) for key, value in found.items()}


def trip_orders(trip: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _trip_orders(*_key(counts, "sales_orders", "delivery_trips")).get(trip, ())


def failed_drops(trip: int, counts: Mapping[str, int]) -> int:
    return sum(order_trips(order, counts)[0] == trip and len(order_trips(order, counts)) > 1
               for order in trip_orders(trip, counts))  # fmt: skip


# Vehicles: vans run the van tours, trucks the delivery trips.


def van_count(counts: Mapping[str, int]) -> int:
    return max(1, counts["vehicles"] // 4)


def vehicle_type(vehicle: int, counts: Mapping[str, int]) -> str:
    if vehicle < van_count(counts):
        return "Van 1-ton"
    if vehicle % 8 == 7:
        return "Motorcycle"
    return "Truck 6-wheel" if vehicle % 3 == 0 else "Truck 4-wheel"


def vehicle_status(vehicle: int) -> str:
    return "Available" if vehicle < PINNED else status("vehicles", vehicle)


def _trucks(vehicles: int) -> tuple[int, ...]:
    counts = {"vehicles": vehicles}
    trucks = tuple(item for item in range(vehicles) if vehicle_type(item, counts)
                   .startswith("Truck") and vehicle_status(item) != "Out of service")  # fmt: skip
    return trucks or (vehicles - 1,)


def trip_vehicle(trip: int, counts: Mapping[str, int]) -> int:
    return pick("vehicle_trips", trip, (counts["vehicles"],),
                lambda: _trucks(counts["vehicles"]), alpha=1.0)  # fmt: skip


def tour_vehicle(tour: int, counts: Mapping[str, int]) -> int:
    return tour % van_count(counts)

