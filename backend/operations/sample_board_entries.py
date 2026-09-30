"""Revisioned Board posts, events, and record links without file insertion."""

from __future__ import annotations

from collections.abc import Collection, Mapping
from datetime import UTC, date, datetime, timedelta
from datetime import time as day_time
from decimal import Decimal, InvalidOperation
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from operations.sample_board_text import revised_post
from operations.sample_client import SampleClient
from operations.sample_content import (
    SampleContentError,
    _id,
    _json,
)
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.registry import default_pack


def create_board_post(
    client: SampleClient,
    board_id: str,
    title: str,
    body: str,
) -> Mapping[str, Any]:
    board = _json(client, "GET", f"/api/boards/{board_id}")
    revision = board.get("revision")
    if board.get("id") != board_id or not isinstance(revision, int) or revision < 1:
        raise SampleContentError("Board revision could not be read before post creation")
    result = _json(
        client,
        "POST",
        f"/api/boards/{board_id}/posts",
        body={
            "board_revision": revision,
            "title": title,
            "body": body,
            "links": [],
            "expires_at": None,
            "pinned": False,
        },
        expected=(201,),
    )
    _id(result)
    return result


def create_board_event(
    client: SampleClient,
    board_id: str,
    payload: Mapping[str, Any],
) -> Mapping[str, Any]:
    if "board_revision" in payload:
        raise ValueError("Event payload must not supply its own Board revision")
    board = _json(client, "GET", f"/api/boards/{board_id}")
    revision = board.get("revision")
    if board.get("id") != board_id or not isinstance(revision, int) or revision < 1:
        raise SampleContentError("Board revision could not be read before event creation")
    result = _json(
        client,
        "POST",
        f"/api/boards/{board_id}/events",
        body={**dict(payload), "board_revision": revision},
        expected=(201,),
    )
    _id(result)
    return result


def _money(
    records: Mapping[str, Mapping[str, Any]],
    fields: Mapping[str, list[Mapping[str, Any]]],
    logical_id: str,
    field_name: str,
) -> Decimal:
    record = records.get(logical_id)
    if record is None or not isinstance(record.get("data"), Mapping):
        raise SampleContentError(f"Named business record is missing: {logical_id}")
    module_key = str(record.get("module_key", ""))
    field = next(
        (
            item
            for item in fields.get(module_key, [])
            if str(item.get("name", "")).casefold() == field_name.casefold()
        ),
        None,
    )
    if field is None:
        raise SampleContentError(
            f"Named business record field is missing: {module_key}.{field_name}"
        )
    try:
        value = Decimal(str(record["data"].get(_id(field))))
    except (InvalidOperation, TypeError, ValueError):
        raise SampleContentError(f"Named business record value is invalid: {logical_id}") from None
    if not value.is_finite():
        raise SampleContentError(f"Named business record value is invalid: {logical_id}")
    return value


def validate_board_scenarios(
    records: Mapping[str, Mapping[str, Any]],
    fields: Mapping[str, list[Mapping[str, Any]]],
    *,
    organization: OrganizationPack | None = None,
    only: Collection[str] | None = None,
) -> dict[str, Any]:
    """Validate golden operational records before any Board metadata is written.

    `only` limits the check to the records one link step uses, so a step does not
    wait for scenario records that a later department creates.
    """
    spec = (organization or default_pack()).content.data
    in_scope = spec.required_records.keys() if only is None else set(only)
    money = [item for item in spec.amounts if item.record in in_scope]
    amounts = {item.key: _money(records, fields, item.record, item.field) for item in money}
    if any(amounts[item.key] != item.expected for item in money) or (
        len(spec.amounts) >= 2
        and all(item.key in amounts for item in spec.amounts[:2])
        and amounts[spec.amounts[0].key] - amounts[spec.amounts[1].key] != spec.scenario_balance
    ):
        raise SampleContentError("Planned linked records do not match their expected amounts")
    record_ids: dict[str, str] = {}
    for logical_id, module_key in spec.required_records.items():
        if logical_id not in in_scope:
            continue
        record = records.get(logical_id)
        if record is None or record.get("module_key") != module_key:
            raise SampleContentError(f"Required scenario record is unavailable: {logical_id}")
        record_ids[logical_id] = _id(record)
    return {**amounts, "record_ids": record_ids}


def _record_link(
    client: SampleClient,
    kind: str,
    board_id: str,
    content_id: str,
    content_revision_key: str,
    record_id: str,
    logical_id: str,
    *,
    view: str | None = None,
) -> None:
    base = f"/api/boards/{board_id}"
    path = f"{base}/{kind}s/{content_id}"
    board = _json(client, "GET", base)
    current = _json(client, "GET", path, params={"view": view} if view else None)
    board_revision = board.get("revision")
    content_revision = current.get(content_revision_key)
    if (
        board.get("id") != board_id
        or not isinstance(board_revision, int)
        or not isinstance(content_revision, int)
    ):
        raise SampleContentError(f"Board or {kind} revision is unavailable for link: {logical_id}")
    linked = _json(
        client,
        "POST",
        f"{path}/record-links",
        body={
            "record_id": record_id,
            "board_revision": board_revision,
            "content_revision": content_revision,
        },
        expected=(201,),
    )
    if linked.get("record_id") != record_id or linked.get("available") is not True:
        raise SampleContentError(f"Board record link was not available: {logical_id}")
    client.record_mapping("edges", f"board:{content_id}:record:{logical_id}", _id(linked))


def event_payload(
    board_index: int,
    index: int,
    anchor_date: date,
    *,
    organization: OrganizationPack | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """One Board event as the event editor saves it, and its reminder settings."""
    pack = organization or default_pack()
    spec = pack.content.data
    timezone = ZoneInfo(pack.identity.timezone)
    now = datetime.now(UTC)
    scheduled_reminder = index < 2
    if scheduled_reminder:
        start = (now + timedelta(days=14 + board_index * 2 + index)).astimezone(timezone)
        event_day = start.date()
    else:
        delta = ((board_index * 37 + index * 29) % 456) - 365
        event_day = anchor_date + timedelta(days=delta)
        start = datetime.combine(event_day, day_time(9 + index % 6), tzinfo=timezone)
    all_day = index % 3 == 2
    recurrence = "weekly" if index in {0, 11} else "monthly" if index in {5, 10} else "none"
    repeat_until = (event_day + timedelta(days=28)).isoformat() if recurrence != "none" else None
    reminders = (
        [spec.reminders[(board_index * 2 + index) % len(spec.reminders)]]
        if scheduled_reminder
        else []
    )
    title = spec.event_titles[(board_index + index) % len(spec.event_titles)]
    payload: dict[str, Any] = {
        "title": title,
        "details": spec.event_details[title],
        "location": spec.event_locations[index % len(spec.event_locations)],
        "links": [],
        "all_day": all_day,
        "timezone_name": pack.identity.timezone,
        "recurrence": recurrence,
        "repeat_until": repeat_until,
        "reminders": reminders,
    }
    if all_day:
        payload.update(start_date=event_day.isoformat(), end_date=event_day.isoformat())
    else:
        start_utc = start.astimezone(UTC)
        payload.update(
            start_at=start_utc.isoformat().replace("+00:00", "Z"),
            end_at=(start_utc + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        )
    return payload, reminders


def finalize_post(
    post: Mapping[str, Any],
    republished_board_ids: set[str],
    now: datetime,
    *,
    organization: OrganizationPack | None = None,
) -> tuple[int, int]:
    """Publish, schedule or archive one post with fresh revisions; the first published post
    on each Board is edited once and published again."""
    publications = revisions = 0
    board, client = post["board"], post["writer"]
    item_path = f"/api/boards/{board['id']}/posts/{post['id']}"
    view = "editable" if post["state"] == "published" else "draft"
    current_board = _json(client, "GET", f"/api/boards/{board['id']}")
    current = _json(client, "GET", item_path, params={"view": view})
    versions = {
        "board_revision": current_board.get("revision"),
        "post_revision": current.get("post_revision"),
    }
    if not all(isinstance(value, int) and value >= 1 for value in versions.values()):
        raise SampleContentError("Board post revision is unavailable for lifecycle action")
    if post["state"] == "published":
        _json(client, "POST", f"{item_path}/publish",
              body={**versions, "publication_key": str(uuid4())})  # fmt: skip
        publications += 1
        if board["id"] not in republished_board_ids:
            fresh_board = _json(client, "GET", f"/api/boards/{board['id']}")
            fresh_post = _json(client, "GET", item_path, params={"view": "editable"})
            title, body = revised_post(post["title"], post["body"], organization=organization)
            _json(client, "PATCH", item_path, body={
                "board_revision": fresh_board.get("revision"),
                "post_revision": fresh_post.get("post_revision"),
                "title": title,
                "body": body,
            })  # fmt: skip
            fresh_board = _json(client, "GET", f"/api/boards/{board['id']}")
            fresh_post = _json(client, "GET", item_path, params={"view": "draft"})
            _json(client, "POST", f"{item_path}/publish", body={
                "board_revision": fresh_board.get("revision"),
                "post_revision": fresh_post.get("post_revision"),
                "publication_key": str(uuid4()),
            })  # fmt: skip
            publications += 1
            revisions += 1
            republished_board_ids.add(board["id"])
    elif post["state"] == "scheduled":
        publish_at = now + timedelta(days=7 + post["board_index"] + post["index"])
        publish = publish_at.isoformat().replace("+00:00", "Z")
        _json(client, "POST", f"{item_path}/schedule", body={**versions, "publish_at": publish})
    else:
        _json(client, "POST", f"{item_path}/archive", body=versions)
    return publications, revisions
