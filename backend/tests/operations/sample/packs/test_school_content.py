"""School Board and OpenView content follows its pack's UK school contract."""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal

from operations.sample.packs import get_pack
from operations.sample.population.board_entries import event_payload

_MARKERS = re.compile(
    r"\b(sample|samples|test|tests|demo|dummy|fake|placeholder|lorem|ipsum|scenario|synthetic)\b",
    re.IGNORECASE,
)


def _school_pack():
    return get_pack("school")


def _content_text(pack) -> list[str]:
    content = pack.content.data
    values = [value for posts in content.posts.values() for post in posts for value in post]
    values.extend(content.event_titles)
    values.extend(content.event_details.values())
    values.extend(content.event_locations)
    values.extend(content.board_descriptions.values())
    values.extend(content.layout_names.values())
    values.extend(content.project_board(name)[1] for name, _department in content.projects)
    values.extend(
        content.view_name(module.key, layout)
        for module in pack.catalog.modules
        for layout in content.layouts
    )
    values.append(content.dashboard_name("Academic Office"))
    values.extend(content.report_names("fee_assessments", "daily", "Status"))
    values.extend(content.revised_post("Term dates", "The autumn term begins on Monday."))
    values.extend(
        content.post_text(
            {"department_key": "finance", "scope": "department"},
            2,
            content.scenario_total,
            content.scenario_paid,
        )
    )
    return [value for value in values if value]


def _board_copy(pack) -> str:
    content = pack.content.data
    values = [value for posts in content.posts.values() for post in posts for value in post]
    values.extend(content.event_titles)
    values.extend(content.event_details.values())
    values.extend(content.event_locations)
    values.extend(content.board_descriptions.values())
    return " ".join(values).lower()


def test_school_content_keeps_termly_fee_scenario_and_board_links_together() -> None:
    pack = _school_pack()
    content = pack.content.data

    assert content.department_groups == {
        "admissions": ("admissions-team", "write"),
        "academic": ("academic-office", "write"),
        "student_affairs": ("student-affairs-office", "write"),
        "health": ("health-services", "write"),
        "finance": ("finance-office", "write"),
        "facilities": ("facilities-team", "write"),
        "hr": ("hr-team", "write"),
    }
    assert content.leads == {
        department: f"internal_{department}_lead" for department in content.department_groups
    }
    assert content.projects == (
        ("Parents' Evening Planning", "academic"),
        ("Clubs and Enrichment Programme", "student_affairs"),
        ("Site Safety Review", "facilities"),
    )
    assert content.project_groups == (("school-staff", "write"), ("guest-auditors", "read"))
    assert content.company_source_department == "finance"
    assert content.required_modules == (
        ("fee_assessments", "finance"),
        ("payments", "finance"),
        ("students", "academic"),
        ("class_sections", "academic"),
    )
    assert content.required_records == {
        "fee_assessments:000001": "fee_assessments",
        "payments:000001": "payments",
        "students:000001": "students",
        "class_sections:000001": "class_sections",
    }
    assert [(item.key, item.record, item.field, item.expected) for item in content.amounts] == [
        ("assessment_total", "fee_assessments:000001", "Net due £", Decimal(4_200)),
        ("payment_amount", "payments:000001", "Amount £", Decimal(1_600)),
    ]
    assert (content.scenario_total, content.scenario_paid, content.scenario_balance) == (
        Decimal(4_200),
        Decimal(1_600),
        Decimal(2_600),
    )
    assert [
        (item.key, item.kind, item.board, item.index, item.records) for item in content.board_links
    ] == [
        (
            "link:finance-post",
            "post",
            "department:finance",
            2,
            ("fee_assessments:000001", "payments:000001"),
        ),
        (
            "link:academic-event",
            "event",
            "department:academic",
            0,
            ("students:000001", "class_sections:000001"),
        ),
    ]

    title, body = content.post_text(
        {"department_key": "finance", "scope": "department"},
        2,
        content.scenario_total,
        content.scenario_paid,
    )
    assert title
    assert "£4,200.00" in body
    assert "£1,600.00" in body
    assert "£2,600.00" in body
    assert "term" in body.lower()
    assert all("school.example" not in text for text in (title, body))


def test_school_board_copy_is_safe_uk_school_content_with_supported_event_settings() -> None:
    pack = _school_pack()
    content = pack.content.data
    texts = _content_text(pack)

    assert pack.identity.locale == "en-GB"
    assert pack.identity.timezone == "Europe/London"
    assert pack.identity.currency_symbol == "£"
    assert any("parents' evenings" in text.lower() for text in texts)
    assert any("year group" in text.lower() or "year-group" in text.lower() for text in texts)
    assert any("autumn term" in text.lower() for text in texts)
    assert any("enrolment" in text.lower() for text in texts)
    assert any("behaviour" in text.lower() for text in texts)
    assert all("₱" not in text for text in texts)

    payload, reminders = event_payload(0, 0, date(2026, 9, 30), organization=pack)
    assert payload["timezone_name"] == "Europe/London"
    assert payload["title"] in content.event_titles
    assert payload["details"] == content.event_details[payload["title"]]
    assert reminders and all(item in {"start", "15m", "1d"} for item in reminders)

    # Public Boards carry no identifying pupil details or private health information.
    public_copy = _board_copy(pack)
    assert "2024-" not in public_copy
    assert "allergy" not in public_copy
    assert "diagnosis" not in public_copy
    assert "clinic visit" not in public_copy
    assert "guidance case" not in public_copy
    for american_term in ("vacation", "homeroom", "counselor", "semester", "report card"):
        assert american_term not in public_copy


def test_school_content_covers_each_board_and_names_views_from_real_module_labels() -> None:
    pack = _school_pack()
    content = pack.content.data
    departments = {key for key, _name in pack.catalog.departments}
    projects = {f"project:{department}" for _name, department in content.projects}

    assert set(content.posts) == {"company", *departments, *projects}
    assert all(len(posts) == 8 for posts in content.posts.values())
    assert all(
        title and body
        for board_key, posts in content.posts.items()
        for index, (title, body) in enumerate(posts)
        if (board_key, index) != ("finance", 2)
    )
    finance_title, finance_body = content.post_text(
        {"department_key": "finance", "scope": "department"},
        2,
        content.scenario_total,
        content.scenario_paid,
    )
    assert finance_title and finance_body
    assert content.post_states == ("draft", "published", "scheduled", "archived")
    assert content.posts_per_board == 8
    assert content.events_per_board == 12
    assert len(content.event_titles) == 12
    assert set(content.event_details) == set(content.event_titles)
    assert content.reminders == ("start", "15m", "1d")
    assert set(content.layout_names) == set(content.layouts)
    assert set(content.layouts) == {"table", "grid", "gallery"}

    module = next(item for item in pack.catalog.modules if item.key == "fee_assessments")
    assert content.view_name(module.key, "table").startswith(module.name)
    report_title = content.report_names(module.key, "daily", "Status")[0]
    assert module.name.casefold() in report_title.casefold()


def test_school_board_and_openview_copy_has_no_unapproved_generation_markers() -> None:
    pack = _school_pack()
    allowed = pack.text.trade_phrases

    offenders = []
    for value in _content_text(pack):
        cleaned = value
        for phrase in allowed:
            cleaned = re.sub(re.escape(phrase), " ", cleaned, flags=re.IGNORECASE)
        if _MARKERS.search(cleaned):
            offenders.append(value)

    assert offenders == []
