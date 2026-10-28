"""Clinic offline admission: control planning, natural text and US clinic content."""

from __future__ import annotations

import re
from dataclasses import asdict
from datetime import date

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.board_text import post_text
from operations.sample.controls.actions import plan_controls
from operations.sample.packs.clinic import PACK
from operations.sample.scenario import build_dataset
from tests.operations.sample.test_sample_text import MARKERS, RESERVED_DOMAIN, RUN_MARKERS

ANCHOR = date(2026, 9, 30)
_FAMILIES = {
    "openview_controls", "board_controls", "access_controls", "sandbox_controls",
    "account_controls", "comms_controls", "audit_controls", "read_controls", "manage_controls",
    "platform_controls", "backup_controls", "jobs_controls",
}  # fmt: skip


def _content_text() -> list[str]:
    content = PACK.content.data
    values = [value for posts in content.posts.values() for post in posts for value in post]
    values += [*content.event_titles, *content.event_details.values(), *content.event_locations]
    values += [*content.board_descriptions.values(), *content.layout_names.values()]
    values += [content.view_name(module.key, layout)
               for module in PACK.catalog.modules for layout in content.layouts]  # fmt: skip
    values += [content.dashboard_name(name) for _key, name in PACK.catalog.departments]
    values += content.report_names("claims", "daily", "Status")
    values += content.post_text({"department_key": "revenue_cycle", "scope": "department"}, 2,
                                content.scenario_total, content.scenario_paid)  # fmt: skip
    kanban = content.kanban
    assert kanban is not None
    values += [card.title or "" for card in kanban.cards]
    values += [name for name, _colour in (*kanban.stages, *kanban.labels)]
    return [value for value in values if value]


def _marked(value: str) -> bool:
    cleaned = RESERVED_DOMAIN.sub(" ", value)
    for phrase in PACK.text.trade_phrases:
        cleaned = re.sub(re.escape(phrase), " ", cleaned, flags=re.IGNORECASE)
    return bool(MARKERS.search(cleaned))


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    if isinstance(value, list | tuple):
        return [text for item in value for text in _strings(item)]
    return []


def test_clinic_small_plans_every_control_family_from_its_own_people_and_records() -> None:
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=PACK)
    actions = plan_controls(dataset)
    assert {action.kind for action in actions} == _FAMILIES
    assert len({action.key for action in actions}) == len(actions)
    actors = {person.key for person in PACK.actors.people} | {"admin", "operator"}
    assert {action.actor_key for action in actions} <= actors
    texts = _strings([asdict(action) for action in actions])
    assert [text for text in texts if _marked(text) or RUN_MARKERS.search(text)] == []


def test_all_clinic_generated_text_passes_the_marker_rule() -> None:
    dataset = build_dataset("standard", 42, ANCHOR, organization=PACK)
    values = [value for record in dataset.records for value in record.data.values()
              if isinstance(value, str)]  # fmt: skip
    values += _content_text()
    values += [post_text({"department_key": key, "scope": "department"}, index,
                         PACK.content.data.scenario_total, PACK.content.data.scenario_paid,
                         organization=PACK)[0]
               for key, _name in PACK.catalog.departments for index in range(8, 30)]  # fmt: skip
    values += [text for person in PACK.actors.people
               for text in (person.email, person.username, person.name, person.title)]  # fmt: skip
    values += [name for _key, name in PACK.catalog.departments]
    values += [text for module in PACK.catalog.modules
               for text in (module.name, *(f.name for f in module.fields),
                            *(label for f in module.fields for label in f.options))]  # fmt: skip
    document = SandboxDocument.model_validate(dataset.document)
    values += [trigger.name for trigger in document.triggers]
    assert [value for value in values if _marked(value)] == []
    emails = [value for value in values if "@" in value and not value.startswith("@user:")]
    assert emails
    assert [value for value in emails if not value.rsplit("@", 1)[1].endswith(".example")] == []


def test_revenue_board_announces_the_named_claim_part_payment() -> None:
    content = PACK.content.data
    title, body = content.post_text(
        {"department_key": "revenue_cycle", "scope": "department"},
        2,
        content.scenario_total,
        content.scenario_paid,
    )
    assert title == "Claim part payment posted"
    assert "$420.00" in body and "$300.00" in body and "$120.00" in body
    assert set(content.posts) == {
        "company", *(key for key, _name in PACK.catalog.departments),
        *(f"project:{department}" for _name, department in content.projects),
    }  # fmt: skip
    assert all(len(posts) == content.posts_per_board for posts in content.posts.values())
    assert set(content.event_details) == set(content.event_titles)
