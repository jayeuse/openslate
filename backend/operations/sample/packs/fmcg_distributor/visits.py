"""Store visits: outcomes and statuses, and the reverse maps outlets and beats read."""

from __future__ import annotations

from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.fmcg_distributor.links import (
    PINNED,
    _key,
    delivered_orders,
    outlet_beat,
    presell_visit_count,
    rng,
    visit_order,
    visit_outlet,
    visit_tour,
    worked_tours,
)
from operations.sample.realism import weighted_label


def van_invoice_total(counts: Mapping[str, int]) -> int:
    return counts["sales_invoices"] - len(delivered_orders(counts["sales_orders"]))


def _chunk(bucket: int, total: int, buckets: int) -> int:
    return -(-(bucket + 1) * total // buckets) - -(-bucket * total // buckets)


def tour_invoice_count(tour: int, counts: Mapping[str, int]) -> int:
    tours = worked_tours(counts)
    if tour not in tours:
        return 0
    return _chunk(tours.index(tour), van_invoice_total(counts), len(tours))


def visit_outcome(visit: int, counts: Mapping[str, int]) -> str | None:
    if visit_order(visit, counts) is not None:
        return "Productive"
    if visit >= presell_visit_count(counts):
        tour, place = visit_tour(visit, counts)
        if place < tour_invoice_count(tour, counts):
            return "Productive"
    state = visit_status(visit, counts)
    if state in {"Planned", "In progress"}:
        return None
    if state == "Not visited":
        return "Not visited"
    return "No order"


def visit_status(visit: int, counts: Mapping[str, int]) -> str:
    if visit < PINNED or visit_order(visit, counts) is not None:
        return "Completed"
    if visit >= presell_visit_count(counts):
        tour, place = visit_tour(visit, counts)
        if place < tour_invoice_count(tour, counts):
            return "Completed"
        return "Not visited" if rng("store_visits", visit, "van").random() < 0.12 else (
            "Completed")  # fmt: skip
    return weighted_label(rng("store_visits", visit, "status"),
                          {"Completed": 62, "Not visited": 18, "Planned": 10, "Abandoned": 6,
                           "In progress": 4})  # fmt: skip


@lru_cache(maxsize=16)
def _outlet_visits(key: tuple[int, ...]) -> dict[int, tuple[int, ...]]:
    counts = dict(zip(_VISIT_KEYS, key, strict=True))
    found: dict[int, list[int]] = {}
    for visit in range(counts["store_visits"]):
        found.setdefault(visit_outlet(visit, counts), []).append(visit)
    return {outlet: tuple(visits) for outlet, visits in found.items()}


_VISIT_KEYS = ("store_visits", "sales_orders", "route_tours", "sales_invoices", "beats",
               "outlets")  # fmt: skip


def outlet_visits(outlet: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    return _outlet_visits(_key(counts, *_VISIT_KEYS)).get(outlet, ())


@lru_cache(maxsize=16)
def _beat_sizes(beats: int, outlets: int) -> dict[int, int]:
    counts = {"beats": beats, "outlets": outlets}
    found: dict[int, int] = {}
    for outlet in range(outlets):
        beat = outlet_beat(outlet, counts)
        if beat is not None:
            found[beat] = found.get(beat, 0) + 1
    return found


def beat_size(beat: int, counts: Mapping[str, int]) -> int:
    return _beat_sizes(*_key(counts, "beats", "outlets")).get(beat, 0)
