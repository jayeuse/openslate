"""Offline checks that a generated plan has a real organization's shape (exit criteria 1-5).

They read only the dataset, so they run with no database. A module or department
with fewer than ``MIN_RECORDS`` records is too small to have a shape and is skipped.
Each pack's ``realism`` module may name its holidays, its computed amounts (sums and
products of other fields) and its structural links (one child per parent slot).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import date
from importlib import import_module

from operations.sample.blueprint import SampleDataset, SampleRecord, _option_id
from operations.sample.packs.types import FieldSpec, JsonValue, ModuleSpec

MIN_RECORDS = 30
# Number fields that hold money; other numbers (scores, quantities, coordinates) do not.
MONEY_MARKERS = ("amount", "total", "price", "cost", "fee", "balance", "due", "value", "credit")


@dataclass
class RealismReport:
    measures: dict[str, float] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)

    def failed(self, criterion: int) -> list[str]:
        return [issue for issue in self.issues if issue.startswith(f"C{criterion} ")]


def _percentile(values: list[float], share: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(share * len(ordered)))]


def is_round(value: float) -> bool:
    """50, 500, 1,500, 5,000 or 10,000: a leading digit (or digit and 5) then zeros."""
    if value <= 0 or not float(value).is_integer():
        return False
    digits = str(int(value)).rstrip("0")
    return len(str(int(value))) >= 2 and (len(digits) == 1 or digits[1:] == "5")


def _day(value: object) -> date | None:
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def pack_realism(dataset: SampleDataset) -> dict[str, Collection[object]]:
    """The pack's own realism declarations, or none for a pack without them."""
    try:
        key = dataset.organization.identity.key
        module = import_module(f"operations.sample.packs.{key}.realism")
    except ModuleNotFoundError:
        return {}
    return {
        "holidays": module.holidays(dataset.anchor_date),
        "computed": getattr(module, "COMPUTED_AMOUNTS", frozenset()),
        "structural": getattr(module, "STRUCTURAL_LINKS", frozenset()),
    }


def realism_report(
    dataset: SampleDataset,
    *,
    holidays: Collection[date] = frozenset(),
    computed: Collection[str] = frozenset(),
    structural: Collection[str] = frozenset(),
) -> RealismReport:
    report = RealismReport()
    pack = dataset.organization
    records_by_module: dict[str, list[SampleRecord]] = defaultdict(list)
    for record in dataset.records:
        records_by_module[record.module_key].append(record)

    for module in pack.catalog.modules:
        rows = records_by_module[module.key]
        if len(rows) < MIN_RECORDS:
            continue
        ids = dataset.field_ids[module.key]
        for spec in module.fields:
            values = [row.data.get(ids[spec.key]) for row in rows]
            if spec.value_kind == "status" and len(module.statuses) >= 4:
                _statuses(report, dataset, module, spec, values)
            elif spec.type == "Number" and any(m in spec.value_kind or m in spec.key
                                               for m in MONEY_MARKERS):  # fmt: skip
                name = f"{module.key}.{spec.key}"
                _amounts(report, name, values, typed=name not in computed)
        date_field = next((spec for spec in module.fields if spec.type == "Date"), None)
        if date_field is not None:
            days = [_day(row.data.get(ids[date_field.key])) for row in rows]
            _dates(report, module.key, [day for day in days if day is not None], holidays)

    _workload(report, dataset)
    _links(report, dataset, records_by_module, structural)
    return report


def _statuses(
    report: RealismReport,
    dataset: SampleDataset,
    module: ModuleSpec,
    spec: FieldSpec,
    values: list[JsonValue | None],
) -> None:
    labels = {
        _option_id(dataset.seed, module.key, spec.key, label, dataset.organization): label
        for label in module.statuses
    }
    # An omitted status is the field's default label, which the server fills in.
    default = str(spec.default_value) if spec.has_default else None
    counts = Counter(default if value is None else labels.get(str(value), default)
                     for value in values)  # fmt: skip
    counts.pop(None, None)
    if not counts:
        return
    ordered = [count for _, count in counts.most_common()]
    top = ordered[0] / sum(ordered)
    report.measures[f"C1 {module.key} top status share"] = top
    if top < 0.5:
        report.issues.append(f"C1 {module.key}: the most common status holds {top:.0%}, below 50%")
    if len(ordered) > 1 and ordered[0] < 2 * ordered[1]:
        report.issues.append(f"C1 {module.key}: the top status is not twice the second (flat)")


def _amounts(
    report: RealismReport, name: str, values: list[JsonValue | None], *, typed: bool
) -> None:
    amounts = [float(v) for v in values if isinstance(v, int | float) and not isinstance(v, bool)]
    positive = [v for v in amounts if v > 0]
    if len(positive) < MIN_RECORDS:
        return
    spread = _percentile(positive, 0.99) / _percentile(positive, 0.5)
    rounded = sum(map(is_round, positive)) / len(positive)
    report.measures[f"C2 {name} p99/p50"] = spread
    report.measures[f"C2 {name} round share"] = rounded
    if spread < 5:
        report.issues.append(f"C2 {name}: p99/p50 is {spread:.1f}, below 5")
    if typed and rounded < 0.05:  # A computed total is rarely a round number.
        report.issues.append(f"C2 {name}: {rounded:.0%} round numbers, below 5%")


def _dates(
    report: RealismReport, module_key: str, days: list[date], holidays: Collection[date]
) -> None:
    if len(days) < MIN_RECORDS:
        return
    weekdays = sum(day.weekday() < 5 for day in days) / len(days)
    report.measures[f"C3 {module_key} weekday share"] = weekdays
    if weekdays < 0.85:
        report.issues.append(f"C3 {module_key}: weekdays hold {weekdays:.0%}, below 85%")
    on_holidays = sum(day in holidays for day in days)
    if on_holidays > max(1, len(days) // 500):
        report.issues.append(f"C3 {module_key}: {on_holidays} records fall on pack holidays")


def _workload(report: RealismReport, dataset: SampleDataset) -> None:
    by_department: dict[str, Counter[str]] = defaultdict(Counter)
    for record in dataset.records:
        by_department[record.actor_key][record.creator_key] += 1
    for department, writers in by_department.items():
        total = sum(writers.values())
        if total < MIN_RECORDS or len(writers) < 3:
            continue
        share = sum(count for _, count in writers.most_common(2)) / total
        report.measures[f"C4 {department} top two writer share"] = share
        if share < 0.4:
            report.issues.append(
                f"C4 {department}: the top two writers hold {share:.0%}, below 40%"
            )


def _links(
    report: RealismReport,
    dataset: SampleDataset,
    records_by_module: dict[str, list[SampleRecord]],
    structural: Collection[str],
) -> None:
    children: dict[str, set[str]] = defaultdict(set)
    for edge in dataset.edges:
        children[edge.relationship_id].update((edge.source_record_id, edge.target_record_id))
    for relationship in dataset.organization.catalog.relationships:
        if relationship.cardinality != "one-to-many" or relationship.key in structural:
            continue
        parent = relationship.source if relationship.child == "target" else relationship.target
        parents = [row.logical_id for row in records_by_module[parent]]
        if len(parents) < MIN_RECORDS:
            continue
        linked = children[dataset.relationship_ids[relationship.key]]
        childless = sum(logical_id not in linked for logical_id in parents) / len(parents)
        report.measures[f"C5 {relationship.key} childless parent share"] = childless
        if childless < 0.05:
            report.issues.append(
                f"C5 {relationship.key}: {childless:.0%} of parents have no children, below 5%"
            )
