"""Generated record text reads like an organization's own data."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator
from dataclasses import asdict
from datetime import date

import pytest

from operations.sample.packs.types import SampleProfile
from operations.sample.scenario import SampleDataset
from operations.sample.vocabulary import TRADE_PHRASES
from tests.operations.sample.sample_datasets import sample_dataset

ANCHOR = date(2026, 9, 30)
MARKERS = re.compile(
    r"\b(sample|samples|test|tests|demo|dummy|fake|placeholder|lorem|ipsum|scenario|synthetic)\b",
    re.IGNORECASE,
)
RUN_MARKERS = re.compile(
    r"\bseed(?:\s+number)?\s*[:#-]?\s*\d+\b"
    r"|\breview copy\s+\d+-\d+\b"
    r"|\s[0-9a-f]{12,}\b"
    r"|\bmetadata verification\b",
    re.IGNORECASE,
)
# Only the reserved domain is exempt; local parts and URL paths are still scanned.
RESERVED_DOMAIN = re.compile(r"[\w-]+(\.[\w-]+)*\.example\b", re.IGNORECASE)
# Well-known brands that a generated name must never borrow.
REAL_BRANDS = (
    "Cebu Pacific",
    "San Miguel",
    "Jollibee",
    "Ayala",
    "Petron",
    "Meralco",
    "PLDT",
    "Globe Telecom",
    "Puregold",
    "Robinsons",
    "Mercury Drug",
    "Philippine Airlines",
    "Unilever",
    "Nestle",
    "Caterpillar",
    "Toyota",
    "Liwayway",
    "Oishi",
    "Monde",
    "Universal Robina",
    "Century Pacific",
    "Del Monte",
)
# Things that are named, not numbered; each record in these modules is unique.
NAMED_MODULES = ("customers", "contacts", "equipment", "products", "suppliers", "warehouses")


def _dataset(profile: str) -> SampleDataset:
    return sample_dataset(profile, 42, ANCHOR)


def _field_ids(dataset: SampleDataset, module_key: str) -> dict[str, str]:
    module = next(
        item
        for item in dataset.document["design"]["modules"]
        if item["id"] == dataset.module_ids[module_key]
    )
    return {field["name"]: field["id"] for field in module["fields"]}


def _values(dataset: SampleDataset, module_key: str, field_name: str) -> list[object]:
    field_id = _field_ids(dataset, module_key)[field_name]
    return [
        record.data.get(field_id) for record in dataset.records if record.module_key == module_key
    ]


def _text_values(dataset: SampleDataset) -> list[str]:
    return [
        value
        for record in dataset.records
        for value in record.data.values()
        if isinstance(value, str)
    ]


def _without_allowed(value: str) -> str:
    cleaned = RESERVED_DOMAIN.sub(" ", value)
    for phrase in TRADE_PHRASES:
        cleaned = re.sub(re.escape(phrase), " ", cleaned, flags=re.IGNORECASE)
    return cleaned


def test_no_generated_value_marks_itself_as_generated() -> None:
    offenders = sorted(
        {
            value
            for value in _text_values(_dataset("standard"))
            if MARKERS.search(_without_allowed(value))
        }
    )
    assert offenders == []


def _strings(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _strings(item)


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
@pytest.mark.parametrize("profile", ("small", "standard"))
def test_every_control_plan_string_uses_natural_organization_content(
    pack_key: str, profile: SampleProfile
) -> None:
    from operations.sample.controls.actions import plan_controls

    dataset = sample_dataset(profile, 42, ANCHOR, pack_key)
    texts = list(_strings([asdict(action) for action in plan_controls(dataset)]))
    assert texts
    offenders = sorted(
        {
            text
            for text in texts
            if MARKERS.search(_without_allowed(text)) or RUN_MARKERS.search(text) or "·" in text
        }
    )
    assert offenders == []


@pytest.mark.parametrize(
    "text",
    (
        "Checkpoint seed 42",
        "Year 8 Pine — review copy 7938092987921336317-1",
        "Sales Review 000000000000002a",
        "Temporary checkpoint; removed after metadata verification.",
    ),
)
def test_control_scan_rejects_run_machinery_labels(text: str) -> None:
    assert RUN_MARKERS.search(text)


@pytest.mark.parametrize(
    "text",
    (
        "Year 8 Pine — Autumn term",
        "September 2026 structure review",
        "Confirm the order for 24 replacement batteries.",
        "6e6a48f9-77c2-44cc-8c4d-2f87a73d47e8",
    ),
)
def test_control_scan_preserves_business_numbers_and_technical_ids(text: str) -> None:
    assert not RUN_MARKERS.search(text)


def test_allowed_trade_phrases_are_real_uses_of_marker_words() -> None:
    assert TRADE_PHRASES, "the allow-list must be explicit, not empty by accident"
    for phrase in TRADE_PHRASES:
        assert MARKERS.search(phrase), f"{phrase!r} needs no allow-list entry"


def test_no_value_borrows_a_real_brand() -> None:
    texts = _text_values(_dataset("standard")) + _content_texts()
    offenders = sorted(
        {text for text in texts if any(brand.lower() in text.lower() for brand in REAL_BRANDS)}
    )
    assert offenders == []


def test_titles_use_business_names_not_machine_codes() -> None:
    titles = [
        value
        for module_key in dict.fromkeys(record.module_key for record in _dataset("small").records)
        for value in _values(_dataset("small"), module_key, "Name")
    ]
    assert all(isinstance(title, str) and title.strip() for title in titles)
    assert not [title for title in titles if "HOG-" in str(title) or "·" in str(title)]
    assert not [
        title
        for title in titles
        if any(brand.lower() in str(title).lower() for brand in REAL_BRANDS)
    ]


@pytest.mark.parametrize("module_key", NAMED_MODULES)
def test_named_things_are_unique_in_the_standard_profile(module_key: str) -> None:
    names = _values(_dataset("standard"), module_key, "Name")
    assert len(set(names)) == len(names)


@pytest.mark.parametrize("profile", ["small", "standard"])
def test_document_titles_rarely_repeat(profile: str) -> None:
    dataset = _dataset(profile)
    for module_key in dict.fromkeys(record.module_key for record in dataset.records):
        if module_key in NAMED_MODULES:
            continue
        names = Counter(_values(dataset, module_key, "Name"))
        most_common = names.most_common(1)[0][1]
        assert most_common <= max(3, sum(names.values()) // 100), module_key


def test_notes_are_varied_and_do_not_repeat_a_template() -> None:
    dataset = _dataset("standard")
    notes = [value for value in _values(dataset, "service_requests", "Notes") if value]
    assert len(set(notes)) >= len(notes) // 4
    assert not [note for note in _text_values(dataset) if "follow-up for" in note.lower()]


def test_every_address_and_link_uses_a_reserved_domain() -> None:
    values = _text_values(_dataset("standard"))
    addresses = [
        value
        for value in values
        if ("@" in value and not value.startswith("@")) or value.startswith("http")
    ]
    assert addresses
    for value in addresses:
        host = value.split("@")[-1] if "@" in value else value.split("/")[2]
        assert host.endswith(".example"), value


def test_contact_email_uses_the_domain_of_its_linked_customer() -> None:
    dataset = _dataset("small")
    customers = {
        record.logical_id: record for record in dataset.records if record.module_key == "customers"
    }
    contacts = {
        record.logical_id: record for record in dataset.records if record.module_key == "contacts"
    }
    website = _field_ids(dataset, "customers")["Website"]
    billing = _field_ids(dataset, "customers")["Billing email"]
    email = _field_ids(dataset, "contacts")["Email"]
    link = dataset.relationship_ids["customer_contacts"]
    for edge in dataset.edges:
        if edge.relationship_id != link:
            continue
        customer = customers[edge.source_record_id].data
        if not (customer.get(website) or customer.get(billing)):
            continue
        domain = str(customer.get(website) or customer.get(billing)).split("@")[-1]
        domain = domain.removeprefix("https://").removeprefix("www.").split("/")[0]
        assert str(contacts[edge.target_record_id].data[email]).endswith("@" + domain)


@pytest.mark.parametrize(
    ("relationship", "parent_module", "child_module"),
    [
        ("customer_quotes", "customers", "quotes"),
        ("customer_orders", "customers", "sales_orders"),
        ("product_movements", "products", "stock_movements"),
        ("site_requests", "customer_sites", "service_requests"),
    ],
)
def test_child_titles_name_their_linked_parent(
    relationship: str, parent_module: str, child_module: str
) -> None:
    dataset = _dataset("small")
    records = {record.logical_id: record for record in dataset.records}
    parent_name = _field_ids(dataset, parent_module)["Name"]
    child_name = _field_ids(dataset, child_module)["Name"]
    link = dataset.relationship_ids[relationship]
    checked = 0
    for edge in dataset.edges:
        if edge.relationship_id != link:
            continue
        parent = str(records[edge.source_record_id].data[parent_name]).split(" — ")[0]
        assert parent in str(records[edge.target_record_id].data[child_name])
        checked += 1
    assert checked


# (module, earlier field, later field): each record's dates follow business order.
DATE_ORDER = (
    ("quotes", "Sent at", "Valid until"),
    ("sales_orders", "Ordered on", "Promised delivery"),
    ("service_contracts", "Signed at", "Renewal date"),
    ("service_requests", "Requested at", "Due date"),
    ("work_orders", "Scheduled for", "Due date"),
    ("purchase_orders", "Confirmed at", "Expected delivery"),
    ("invoices", "Issued at", "Due date"),
    ("expenses", "Incurred on", "Submitted at"),
)
SAME_DAY = (
    ("goods_receipts", "Received on", "Received at"),
    ("payments", "Paid on", "Posted at"),
    ("credit_notes", "Issued on", "Issued at"),
)


@pytest.mark.parametrize(("module_key", "earlier", "later"), DATE_ORDER + SAME_DAY)
def test_related_dates_follow_business_order(module_key: str, earlier: str, later: str) -> None:
    dataset = _dataset("standard")
    pairs = [
        (str(first)[:10], str(second)[:10])
        for first, second in zip(
            _values(dataset, module_key, earlier), _values(dataset, module_key, later), strict=True
        )
        if first and second
    ]
    assert pairs
    if (module_key, earlier, later) in SAME_DAY:
        assert all(first == second for first, second in pairs)
    else:
        assert all(first <= second for first, second in pairs)


def _content_texts() -> list[str]:
    from decimal import Decimal

    from operations.sample.packs.harbor import content_text as harbor_content_text

    dataset = _dataset("small")
    organization = dataset.organization
    content = organization.content.data

    texts = [
        text for posts in harbor_content_text.POSTS.values() for post in posts for text in post
    ]
    texts += list(harbor_content_text.EVENT_DETAILS) + list(
        harbor_content_text.EVENT_DETAILS.values()
    )
    texts += list(harbor_content_text.EVENT_LOCATIONS)
    texts += [
        text
        for name in harbor_content_text._BOARD_DESCRIPTIONS
        for text in content.project_board(name)
    ]
    texts += list(content.revised_post("Title", "Body."))
    scenario_board = next(link.board for link in content.board_links if link.kind == "post")
    department_key = scenario_board.split(":", maxsplit=1)[-1]
    scenario = {"department_key": department_key, "scope": "department"}
    texts += list(
        content.post_text(
            scenario, 0, Decimal(content.scenario_total), Decimal(content.scenario_paid)
        )
    )
    modules = dict.fromkeys(record.module_key for record in dataset.records)
    texts += [
        content.view_name(module, layout) for module in modules for layout in content.layout_names
    ]
    department_name = organization.catalog.departments[1][1]
    texts += [content.dashboard_name(department_name)]
    texts += list(content.report_names(next(iter(modules)), "weekly", "Status"))
    texts += [
        value
        for person in organization.actors.people
        for value in (person.email, person.username, person.title)
    ]
    return [text for text in texts if text]


def test_board_openview_and_people_text_never_marks_itself_as_generated() -> None:
    assert MARKERS.search(_without_allowed("Scenario note 5506")), "the scan must catch markers"
    offenders = [text for text in _content_texts() if MARKERS.search(_without_allowed(text))]
    assert offenders == []
    assert not [text for text in _content_texts() if "$" in text or "HOG-" in text]


# (relationship or reference, parent module, parent date field, child module, child date field)
LINKED_DATES = (
    ("invoice_payments", "invoices", "Issued at", "payments", "Paid on"),
    ("invoice_credits", "invoices", "Issued at", "credit_notes", "Issued on"),
    ("request_updates", "service_requests", "Requested at", "request_updates", "Updated on"),
    ("purchase_order_receipts", "purchase_orders", "Confirmed at", "goods_receipts", "Received on"),
    ("work_order_inspections", "work_orders", "Scheduled for", "inspections", "Inspected on"),
)
# Dates of things that already happened by the anchor date.
PAST_EVENTS = (
    ("payments", "Paid on"),
    ("goods_receipts", "Received on"),
    ("request_updates", "Updated on"),
    ("inspections", "Inspected on"),
    ("service_requests", "Requested at"),
    ("invoices", "Issued at"),
    ("purchase_orders", "Confirmed at"),
)


@pytest.mark.parametrize(
    ("relationship", "parent", "parent_field", "child", "child_field"), LINKED_DATES
)
def test_linked_records_happen_after_their_parent(
    relationship: str, parent: str, parent_field: str, child: str, child_field: str
) -> None:
    dataset = _dataset("standard")
    records = {record.logical_id: record for record in dataset.records}
    parent_id = _field_ids(dataset, parent)[parent_field]
    child_id = _field_ids(dataset, child)[child_field]
    link = dataset.relationship_ids[relationship]
    late = [
        edge.target_record_id
        for edge in dataset.edges
        if edge.relationship_id == link
        and str(records[edge.target_record_id].data.get(child_id))[:10]
        < str(records[edge.source_record_id].data.get(parent_id))[:10]
    ]
    assert late == []


@pytest.mark.parametrize(("module_key", "field_name"), PAST_EVENTS)
def test_things_that_happened_are_not_dated_in_the_future(module_key: str, field_name: str) -> None:
    future = [
        value
        for value in _values(_dataset("standard"), module_key, field_name)
        if value and str(value)[:10] > ANCHOR.isoformat()
    ]
    assert future == []


@pytest.mark.parametrize("module_key", ["customers", "suppliers"])
def test_neighbouring_company_names_do_not_share_a_first_word(module_key: str) -> None:
    names = [str(name) for name in _values(_dataset("small"), module_key, "Name")]
    for first, second in zip(names, names[1:], strict=False):
        assert first.split()[0] != second.split()[0], (first, second)
