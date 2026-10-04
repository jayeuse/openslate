"""Sample Boards and OpenView content through the authenticated UI APIs."""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date
from typing import Any

from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack

_PAGE_LIMIT = 100
# Department leads build their department's shared views, dashboards and reports.


class SampleContentError(RuntimeError):
    """A safe operator-facing content workflow failure."""


def _code(response: Any) -> str | None:
    try:
        value = response.json().get("detail", {}).get("code")
    except (AttributeError, TypeError, ValueError):
        return None
    return value if isinstance(value, str) and re.fullmatch(r"[a-z_]{1,64}", value) else None


def _id(item: Mapping[str, Any], key: str = "id") -> str:
    value = item.get(key)
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,35}", value):
        raise SampleContentError(f"API response is missing a valid {key}")
    return value


def _json(
    client: SampleClient,
    method: str,
    path: str,
    *,
    body: Mapping[str, Any] | None = None,
    params: Mapping[str, str | int] | None = None,
    headers: Mapping[str, str] | None = None,
    content: bytes | None = None,
    expected: tuple[int, ...] = (200, 201),
) -> dict[str, Any]:
    response = client.request(
        method, path, json_body=body, params=params, headers=headers, content=content
    )
    if response.status_code not in expected:
        code = _code(response)
        suffix = f" ({code})" if code else ""
        raise SampleContentError(f"{method} {path} returned HTTP {response.status_code}{suffix}")
    try:
        result = response.json()
    except ValueError:
        raise SampleContentError(f"{method} {path} returned invalid JSON") from None
    if not isinstance(result, dict):
        raise SampleContentError(f"{method} {path} returned an invalid object")
    return result


def _pages(
    client: SampleClient, path: str, params: Mapping[str, str | int] | None = None
) -> list[dict[str, Any]]:
    fixed = dict(params or {})
    offset = 0
    values: list[dict[str, Any]] = []
    for _ in range(1000):
        query = {**fixed, "limit": _PAGE_LIMIT, "offset": offset}
        page = _json(client, "GET", path, params=query)
        items, paging = page.get("items"), page.get("pagination")
        if not isinstance(items, list) or not isinstance(paging, dict):
            raise SampleContentError(f"GET {path} returned invalid pagination")
        count, total = paging.get("count"), paging.get("total")
        more = paging.get("has_more")
        if (
            paging.get("limit") != _PAGE_LIMIT
            or paging.get("offset") != offset
            or count != len(items)
            or not isinstance(total, int)
            or not isinstance(more, bool)
            or more != (offset + len(items) < total)
        ):
            raise SampleContentError(f"GET {path} returned inconsistent pagination")
        values.extend(item for item in items if isinstance(item, dict))
        if not more:
            return values
        offset += _PAGE_LIMIT
    raise SampleContentError(f"GET {path} exceeded the bounded page count")


def _empty(client: SampleClient, path: str, params: Mapping[str, str | int] | None = None) -> None:
    if _pages(client, path, params):
        raise SampleContentError(f"Existing content prevents population: {path}")


def _attachment_count(
    client: SampleClient, path: str, *, view: str | None = None
) -> tuple[int, int]:
    count = failed = offset = 0
    while True:
        params: dict[str, str | int] = {"limit": 100, "offset": offset}
        if view is not None:
            params["view"] = view
        try:
            page = _json(client, "GET", path, params=params)
        except (SampleClientError, SampleContentError):
            return count, failed + 1
        items = page.get("items")
        if not isinstance(items, list):
            return count, failed + 1
        count += sum(1 for item in items if isinstance(item, dict) and item.get("state") == "ready")
        if page.get("has_more") is not True:
            return count, failed
        offset += len(items)
        if not items or offset > 10_000:
            return count, failed + 1


def _link_count(client: SampleClient, path: str, *, view: str | None = None) -> tuple[int, int]:
    params: dict[str, str | int] = {"limit": 20, "offset": 0}
    if view is not None:
        params["view"] = view
    try:
        page = _json(client, "GET", path, params=params)
    except (SampleClientError, SampleContentError):
        return 0, 1
    items = page.get("items")
    if not isinstance(items, list):
        return 0, 1
    return len(items), int(page.get("has_more") is True)


def assert_empty_content(admin: SampleClient, boards: list[Mapping[str, Any]]) -> None:
    current = _pages(
        admin,
        "/api/boards",
        {"status": "all", "sort_by": "name", "sort_order": "asc"},
    )
    if (
        len(current) != 1
        or current[0].get("scope") != "company"
        or current[0].get("name") != "Company"
        or current[0].get("status") != "active"
        or len(boards) != 1
        or boards[0].get("id") != current[0].get("id")
    ):
        raise SampleContentError("Existing content prevents population: unexpected Board baseline")
    board_id = str(current[0]["id"])
    base = f"/api/boards/{board_id}"
    for view in ("editable", "archive"):
        _empty(admin, f"{base}/posts", {"view": view})
    _empty(admin, f"{base}/events", {"archived": "all"})
    _empty(admin, f"{base}/widgets")
    _empty(admin, f"{base}/files")
    _empty(admin, "/api/views", {"deleted": "include"})
    _empty(admin, "/api/dashboards", {"deleted": "include"})
    _empty(admin, "/api/reports", {"deleted": "include"})
    _empty(admin, "/api/reports/shared-runs", {"sort_by": "created_at", "sort_order": "desc"})


def prepare_content(
    admin: SampleClient,
    *,
    clients: Mapping[str, SampleClient],
    departments: Mapping[str, Mapping[str, Any]],
    modules: Mapping[str, Mapping[str, Any]],
    fields: Mapping[str, list[Mapping[str, Any]]],
    groups: Mapping[str, str],
    anchor_date: date,
    organization: OrganizationPack | None = None,
) -> tuple[Any, dict[str, int]]:
    """Set up Boards and plan the Board work people do between record sessions."""
    from operations.sample.population.board_steps import BoardMeta, BoardQueue, plan_board_steps
    from operations.sample.population.boards import prepare_boards

    board_specs, counts = prepare_boards(
        admin,
        clients=clients,
        departments=departments,
        modules=modules,
        fields=fields,
        groups=groups,
        organization=organization,
    )
    metas = [
        BoardMeta(board["logical_id"], board["department_key"], board["scope"], board["authors"])
        for board in board_specs
    ]
    queue = BoardQueue(
        steps=plan_board_steps(metas, organization=organization),
        boards={board["logical_id"]: board for board in board_specs},
        clients=clients,
        fields=fields,
        anchor_date=anchor_date,
        organization=organization,
    )
    return queue, counts


def finish_content(
    admin: SampleClient,
    queue: Any,
    *,
    clients: Mapping[str, SampleClient],
    records: Mapping[str, Mapping[str, Any]],
    board_counts: Mapping[str, int],
    departments: Mapping[str, Mapping[str, Any]],
    modules: Mapping[str, Mapping[str, Any]],
    fields: Mapping[str, list[Mapping[str, Any]]],
    anchor_date: date,
    seed: int,
    organization: OrganizationPack | None = None,
) -> Mapping[str, int]:
    """Finish remaining Board work, then leads build views, dashboards and reports."""
    from operations.sample.population.openview import populate_openview

    entries = queue.flush(records)
    pack = organization or default_pack()
    writers = {key: clients.get(pack.content.data.leads[key], admin) for key in departments}
    openview = populate_openview(
        admin,
        departments=departments,
        modules=modules,
        fields=fields,
        anchor_date=anchor_date,
        seed=seed,
        writers=writers,
        actor_clients=clients,
        organization=pack,
    )
    return {**board_counts, **entries, **openview}


def verify_content(
    admin: SampleClient,
    *,
    run_manifest: Mapping[str, Any],
    mappings: Mapping[str, Mapping[str, str]],
    organization: OrganizationPack | None = None,
) -> Mapping[str, int]:
    from operations.sample.population.boards import verify_boards
    from operations.sample.population.openview import verify_openview

    board_counts = verify_boards(admin, mappings=mappings, organization=organization)
    openview_counts = verify_openview(admin, mappings=mappings)
    observed = {**board_counts, **openview_counts}
    observed["read_failures"] = board_counts.get("read_failures", 0) + openview_counts.get(
        "read_failures", 0
    )
    expected = run_manifest.get("expected", {})
    content_keys = (
        "boards",
        "widgets",
        "posts",
        "events",
        "reminders",
        "files",
        "record_links",
        "project_group_grants",
        "post_publications",
        "publication_revisions",
        "views",
        "dashboards",
        "dashboard_widgets",
        "reports",
        "report_runs",
        "schedules",
        "disabled_schedules",
    )
    complete = True
    for key in content_keys:
        target = expected.get(key) if isinstance(expected, Mapping) else None
        if isinstance(target, int) and not isinstance(target, bool) and key in observed:
            observed[f"expected_{key}"] = target
            observed[f"missing_{key}"] = max(target - observed[key], 0)
            complete &= target == observed[key]
        else:
            complete = False
    if "report_runs" in observed and "report_outputs" in observed:
        observed["missing_report_outputs"] = max(
            observed["report_runs"] - observed["report_outputs"], 0
        )
        complete &= observed["report_runs"] == observed["report_outputs"]
    complete &= observed["read_failures"] == 0
    observed["content_complete"] = int(complete)
    return observed
