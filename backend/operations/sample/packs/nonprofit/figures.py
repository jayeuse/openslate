"""Foundation counts, measures, booleans and short texts that follow the record's state."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date

from operations.sample.packs.nonprofit import dates, links, text, vocabulary
from operations.sample.packs.nonprofit.catalog_fields import AWARDED
from operations.sample.packs.nonprofit.links import PERIODS, PINNED, rng, status
from operations.sample.packs.nonprofit.realism import ITEM_VALUES
from operations.sample.packs.nonprofit.timeline import business_day
from operations.sample.packs.nonprofit.values import assistance_type, procurement_method
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec

_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
_SUMMARIES = {
    "Livelihood": "Training, starter kits and seed capital for {households} households.",
    "Education support": "Tutoring, school kits and subsidies for {households} learners.",
    "Disaster response": "Food, kits and multipurpose cash for {households} affected households.",
    "DRR and preparedness": "Early warning committees, drills and kits in {households} "
                            "households' communities.",
}  # fmt: skip
_VERIFICATION = {
    "Number": "Distribution lists and attendance sheets, checked by MEAL.",
    "Percentage": "Post-distribution monitoring through a sample survey of households.",
    "Average": "Household income survey at baseline and endline.",
}


def birth_date(index: int, seed: int, anchor: date) -> str:
    return dates.birth_date(index, seed, anchor).isoformat()


def month_year(anchor: date, months: int) -> str:
    """The month a contract or fund ends, written as people write it."""
    month = anchor.year * 12 + anchor.month - 1 + months
    return f"{month % 12 + 1:02d}/{month // 12}"


def period_label(result: int, anchor: date, counts: Mapping[str, int]) -> str:
    indicator, _rank = links.result_slot(result, counts)
    ended = business_day("indicator_results", "period_end", result, 0, anchor, counts)
    assert ended is not None
    frequency = links.indicator_frequency(indicator)
    if frequency == "Monthly":
        return f"{_MONTHS[ended.month - 1]} {ended.year}"
    if frequency == "Quarterly":
        return f"Q{(ended.month - 1) // 3 + 1} {ended.year}"
    if frequency == "Semiannual":
        return f"H{1 if ended.month <= 6 else 2} {ended.year}"
    return f"Year to {_MONTHS[ended.month - 1]} {ended.year}"


def _unit(indicator: int) -> str:
    return vocabulary.INDICATORS[indicator % len(vocabulary.INDICATORS)][1]


def indicator_target(indicator: int) -> int:
    draw = rng("indicators", indicator, "target")
    unit = _unit(indicator)
    if unit == "Percentage":
        return 5 * draw.randint(12, 18)
    if unit == "Average":
        return 500 * draw.randint(12, 18)
    return 50 * draw.randint(4, 60)


def _baseline(indicator: int) -> int | object:
    unit = _unit(indicator)
    draw = rng("indicators", indicator, "baseline")
    if unit == "Percentage":
        return 5 * draw.randint(4, 11)
    if unit == "Average":
        return 250 * draw.randint(14, 22)
    return 0 if indicator % 3 else OMIT


def result_figures(result: int, counts: Mapping[str, int]) -> dict[str, int | float]:
    indicator, _rank = links.result_slot(result, counts)
    unit, lop = _unit(indicator), indicator_target(indicator)
    periods = PERIODS[links.indicator_frequency(indicator)] or 1
    target = max(1, round(lop / (periods + 1))) if unit == "Number" else lop
    draw = rng("indicator_results", result, "ratio")
    band = draw.random()
    ratio = (0.62 if result == 0 else draw.uniform(0.85, 1.15) if band < 0.75
             else draw.uniform(0.7, 0.85) if band < 0.93 else draw.uniform(0.4, 0.7))  # fmt: skip
    actual: int | float = round(target * ratio)
    if unit == "Percentage":
        actual = min(100.0, round(target * ratio, 1))
    share = draw.uniform(0.52, 0.68)
    return {"actual": actual, "period_target": target, "female": round(actual * share),
            "pct_of_target": round(float(actual) / target * 100, 1)}  # fmt: skip


def _households(project: int) -> int:
    return 10 * rng("projects", project, "households").randint(12, 150)


def _participants(activity: int, state: str) -> tuple[int, int] | None:
    if state not in {"Completed", "Ongoing"}:
        return None
    sizes = {"Distribution": (60, 250), "Training": (15, 35), "Tutoring session": (10, 25),
             "Community meeting": (20, 80), "Drill": (40, 160)}  # fmt: skip
    low, high = sizes.get(links.activity_type(activity), (8, 30))
    draw = rng("activities", activity, "participants")
    total = draw.randint(low, high)
    female = round(total * draw.uniform(0.55, 0.72))
    return female, total - female


def _grant_ends(grant: int, anchor: date, counts: Mapping[str, int]) -> str | object:
    stage = status("grant_awards", grant, counts)
    months = {AWARDED: 12 + grant % 25, "Active": 3 + grant % 22, "Closing": grant % 3,
              "Closed": -1 - grant % 10}.get(stage)  # fmt: skip
    return OMIT if months is None else month_year(anchor, months)


def field_value(
    module: ModuleSpec, field: FieldSpec, index: int, seed: int, anchor: date,
    counts: Mapping[str, int], state: str,
) -> JsonValue | object:  # fmt: skip
    key, name = module.key, field.key
    draw = random.Random(f"{seed}:{key}:{index}:{name}:fcdf")
    if (key, name) == ("donors", "donor_since"):
        return anchor.year if state in {"First-time", "Prospect"} else anchor.year - \
            draw.choice((1, 1, 2, 2, 3, 4, 5, 7, 9))  # fmt: skip
    if (key, name) == ("volunteers", "volunteer_since"):
        return anchor.year - draw.choice((0, 0, 1, 1, 2, 3, 5))
    if name == "city":
        return vocabulary.CITIES[(index * 3 + seed) % len(vocabulary.CITIES)]
    if name == "installments":
        return links.installments(index, counts)
    if name == "contact_person":
        return text.person(index, seed, "contact")
    if (key, name) == ("organizations", "mou_ends"):
        if links.org_role(index) != "Implementing partner":
            return OMIT
        return month_year(anchor, -1 - index % 9 if state == "Inactive" else 3 + index % 24)
    if (key, name) == ("grant_awards", "ends"):
        return _grant_ends(index, anchor, counts)
    if (key, name) == ("funds", "expiry"):
        grant = links.fund_grant(index, counts)
        return OMIT if grant is None else _grant_ends(grant, anchor, counts)
    if name == "indirect_rate":
        return draw.choice((0, 7, 7, 10, 10, 12, 15))
    if name == "cost_share":
        return draw.random() < 0.3
    if name == "special_conditions":
        conditions = vocabulary.GRANT_CONDITIONS
        return conditions[index % len(conditions)] if index % 3 else OMIT
    if name == "line_code":
        return text.line_code(index)
    if (key, name) == ("projects", "period"):
        start = anchor.year - index % 3
        return f"Jan {start} – Dec {start + 1 + index % 2}"
    if name == "target_households":
        return _households(index)
    if (key, name) == ("projects", "budget"):
        return 50_000 * rng("projects", index, "budget").randint(30, 160)
    if name == "summary":
        area = vocabulary.PROJECTS[index % len(vocabulary.PROJECTS)][2]
        return _SUMMARIES[area].format(households=_households(index))
    if name == "province":
        town = (index // 3) % len(vocabulary.MUNICIPALITIES)
        return vocabulary.PROVINCES[town % len(vocabulary.PROVINCES)]
    if name == "municipality":
        return vocabulary.MUNICIPALITIES[(index // 3) % len(vocabulary.MUNICIPALITIES)]
    if name == "households":
        return 10 * draw.randint(8, 90)
    if name == "access_notes":
        return vocabulary.ACCESS_NOTES[index % len(vocabulary.ACCESS_NOTES)]
    if (key, name) in {("activities", "female"), ("activities", "male")}:
        people = _participants(index, state)
        return OMIT if people is None else people[0 if name == "female" else 1]
    if name == "household_size":
        return draw.choices(range(1, 11), weights=(4, 8, 13, 17, 18, 14, 10, 7, 5, 4))[0]
    if name == "head_of_household":
        return draw.random() < 0.6
    if name == "consent_recorded":
        return not (state in {"Pending consent", "Consent withdrawn"}
                    or (state == "Pre-registered" and index % 2 == 0))  # fmt: skip
    return _later_fields(module, field, index, seed, anchor, counts, state, draw)


def _later_fields(
    module: ModuleSpec, field: FieldSpec, index: int, seed: int, anchor: date,
    counts: Mapping[str, int], state: str, draw: random.Random,
) -> JsonValue | object:  # fmt: skip
    key, name = module.key, field.key
    if (key, name) == ("assistance", "round"):
        return 1 + index % 4
    if (key, name) == ("assistance", "quantity"):
        kind = assistance_type(index, counts)
        return draw.randint(4, 12) if kind in {"Tutoring package", "Psychosocial session"} else (
            draw.choice((1, 1, 1, 1, 2)))
    if name == "unit_value":
        price = ITEM_VALUES[assistance_type(index, counts)]
        return price or OMIT
    if name == "received_by_proxy":
        return draw.random() < 0.08
    if name == "statement":
        return vocabulary.INDICATORS[index % len(vocabulary.INDICATORS)][2]
    if (key, name) == ("indicators", "baseline"):
        return _baseline(index)
    if name == "lop_target":
        return indicator_target(index)
    if name == "verification":
        return _VERIFICATION[_unit(index)]
    if (key, name) == ("indicator_results", "period"):
        return period_label(index, anchor, counts)
    if key == "indicator_results" and name in {"actual", "period_target", "pct_of_target",
                                                "female", "male"}:  # fmt: skip
        figures = result_figures(index, counts)
        indicator = links.result_slot(index, counts)[0]
        if name in {"female", "male"}:
            if _unit(indicator) != "Number" or indicator % 4 == 3:
                return OMIT
            female = figures["female"]
            return female if name == "female" else figures["actual"] - female
        return figures[name]
    if name == "description":
        from operations.sample.packs.nonprofit.values import feedback_category

        return vocabulary.FEEDBACK[feedback_category(index)]
    if name == "response":
        if state not in {"Resolved", "Closed"}:
            return OMIT
        return vocabulary.RESPONSES[index % len(vocabulary.RESPONSES)]
    if name == "purpose":
        return vocabulary.PURPOSES[index % len(vocabulary.PURPOSES)]
    if (key, name) == ("expense_lines", "payee"):
        return text.payee(index)
    if (key, name) == ("disbursements", "payee"):
        return text.voucher_payee(index, seed, counts)
    if (key, name) == ("donations", "receipt_no"):
        if state not in {"Posted", "Received"}:
            return OMIT
        return f"AR-{anchor.year}-{(index * 37 + 1_201) % 100_000:05d}"
    if (key, name) == ("expense_lines", "receipt_no"):
        return OMIT if index % 20 == 19 else f"OR {(index * 7_919 + 10_233) % 1_000_000:06d}"
    if name == "tin":
        return text.tin(index)
    if name == "quotes_received":
        method = procurement_method(index)
        if method == "Micro-purchase":
            return draw.choice((0, 1, 1))
        if method == "Open tender":
            return draw.randint(4, 7)
        return 1 if method == "Single source – justified" else draw.choice((3, 3, 3, 2, 4))
    if name == "justification":
        return vocabulary.JUSTIFICATIONS[index % len(vocabulary.JUSTIFICATIONS)]
    if name == "receiving_notes":
        if state not in {"Received", "Paid", "Closed", "Partially received"}:
            return OMIT
        notes = vocabulary.NOTES["procurement"]
        return notes[index % len(notes)]
    if name == "code_of_conduct":
        return state in {"Active", "Inactive", "Offboarded"} or draw.random() < 0.5
    if name == "year":
        return anchor.year
    raise ValueError(f"Unsupported Fairhaven field generator {key}.{name}")


__all__ = ["PINNED", "field_value", "period_label"]
