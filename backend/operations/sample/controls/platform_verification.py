"""Platform response pagination and exact sample request evidence."""

from collections.abc import Mapping
from typing import Any, cast

from operations.sample.blueprint import SampleDataset
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError


def validate_platform_page(
    body: Mapping[str, Any], limit: int, step: str, *, offset: int = 0
) -> list[dict[str, Any]]:
    rows, page = body.get("items"), body.get("pagination")
    if (
        not isinstance(rows, list)
        or any(not isinstance(row, dict) for row in rows)
        or not isinstance(page, Mapping)
    ):
        raise SamplePhaseActionError("Platform page is malformed", step=step)
    if (
        any(type(page.get(key)) is not int for key in ("limit", "offset", "count", "total"))
        or page.get("limit") != limit
        or page.get("offset") != offset
        or page.get("count") != len(rows)
        or page.get("total", -1) < len(rows)
        or page.get("count") != min(limit, max(page["total"] - offset, 0))
        or page.get("has_more") is not (page["total"] > offset + len(rows))
    ):
        raise SamplePhaseActionError("Platform pagination differs from its request", step=step)
    return cast(list[dict[str, Any]], rows)


def verify_platform_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.controls.platform import (
        EVIDENCE_KEYS,
        OPERATIONS,
        READ_CHECKS,
        RECORD_KEYS,
        plan_platform_controls,
    )
    from operations.sample.controls.request_verification import _canonical_uuid

    rows, mappings = result.get("request_evidence"), manifest.get("mappings")
    operation = action.values.get("operation")
    pages = result.get("search_pages")
    checks = READ_CHECKS.get(operation) if isinstance(operation, str) else None
    if operation == OPERATIONS[1]:
        if (
            not isinstance(pages, Mapping)
            or set(pages) != {"record", "person", "post", "event"}
            or any(type(value) is not int or not 1 <= value <= 100 for value in pages.values())
        ):
            issues.append("Platform search page counts differ from the bounded contract")
            return
        checks = 5 + sum(pages.values())
    if (
        action not in plan_platform_controls(dataset)
        or not isinstance(operation, str)
        or not isinstance(rows, list)
        or type(result.get("read_checks")) is not int
        or result.get("read_checks") != checks
        or any(
            type(result.get(key)) is not type(value) or result.get(key) != value
            for key, value in action.expected_end_state.items()
        )
        or not isinstance(mappings, Mapping)
    ):
        issues.append("Platform control plan, end state or read count differs")
        return
    records = mappings.get("platform_records")
    if (
        not isinstance(records, Mapping)
        or set(records) != set(RECORD_KEYS)
        or any(_canonical_uuid(value) is None for value in records.values())
        or len(set(records.values())) != 2
    ):
        issues.append("Platform imported record mappings differ")
        return
    expected: list[tuple[str, str, str, int]] = []

    def add(step: str, method: str, path: str, status: int = 200) -> None:
        expected.append((step, method, path, status))

    if operation == OPERATIONS[0]:
        for step, path in (
            ("before_import", "query"),
            ("preview_import", "import"),
            ("after_preview", "query"),
            ("commit_import", "import"),
            ("after_import", "query"),
        ):
            add(step, "POST", f"/api/records/{path}")
        for key in RECORD_KEYS:
            add(f"read_import_{key}", "GET", f"/api/records/{records[key]}")
    elif operation == OPERATIONS[1]:
        add("search_record_oracle", "GET", f"/api/records/{records[RECORD_KEYS[0]]}")
        identities = {}
        for kind, bucket in (
            ("person", "user"),
            ("board", "boards"),
            ("post", "posts"),
            ("event", "events"),
        ):
            values = mappings.get(bucket)
            identifier = (
                values.get(action.values[f"{kind}_key"]) if isinstance(values, Mapping) else None
            )
            if _canonical_uuid(identifier) is None:
                issues.append("Platform search oracle mapping is invalid")
                return
            identities[kind] = identifier
        add("search_person_oracle", "GET", f"/api/users/{identities['person']}")
        board = f"/api/boards/{identities['board']}"
        add("search_board_oracle", "GET", board)
        for kind in ("post", "event"):
            add(f"search_{kind}_oracle", "GET", f"{board}/{kind}s/{identities[kind]}")
        for kind in ("record", "person", "post", "event"):
            assert isinstance(pages, Mapping)
            for index in range(pages[kind]):
                step = f"search_{kind}" if index == 0 else f"search_{kind}_page_{index * 10}"
                add(step, "GET", "/api/search")
    elif operation == OPERATIONS[2]:
        add("export_csv", "POST", "/api/records/export")
        for key in RECORD_KEYS:
            add(f"before_delete_{key}", "GET", f"/api/records/{records[key]}")
        for key in RECORD_KEYS:
            path = f"/api/records/{records[key]}"
            for step, method, suffix, status in (
                ("delete", "DELETE", "", 204),
                ("deleted", "GET", "", 200),
                ("preview_purge", "POST", "/purge/preview", 200),
                ("purge", "POST", "/purge", 200),
                ("purged", "GET", "", 404),
            ):
                add(f"{step}_{key}", method, path + suffix, status)
    else:
        if result.get("original_theme") not in ("light", "dark"):
            issues.append("Platform original self theme is invalid")
            return
        for step, method in (
            (("read_original_theme", "GET"),)
            if operation == OPERATIONS[3]
            else (
                ("theme_before_toggle", "GET"),
                ("toggle_theme", "PATCH"),
                ("theme_changed_readback", "GET"),
                ("restore_theme", "PATCH"),
                ("theme_restore_readback", "GET"),
            )
        ):
            add(step, method, f"/api/users/{admin_id}/preferences")
    actual: list[tuple[Any, ...]] = []
    for row in rows:
        if not isinstance(row, Mapping) or set(row) != set(EVIDENCE_KEYS):
            issues.append("Platform request descriptor shape differs")
            return
        descriptor = tuple(row.get(key) for key in ("step", "method", "path", "expected_status"))
        repeat = (
            operation == OPERATIONS[2]
            and actual
            and descriptor == actual[-1]
            and descriptor[0] in {f"preview_purge_{key}" for key in RECORD_KEYS}
        )
        if not repeat:
            actual.append(descriptor)
        request_id = _canonical_uuid(row.get("request_id"))
        if (
            row.get("actor_key") != "admin"
            or row.get("actor_id") != admin_id
            or type(row.get("expected_status")) is not int
            or type(row.get("status_code")) is not int
            or row["status_code"] != row["expected_status"]
            or request_id is None
            or request_id in seen_request_ids
        ):
            issues.append("Platform request actor, status or unique identity differs")
            return
        seen_request_ids.add(request_id)
    if actual != expected:
        issues.append("Platform request steps, routes or order differ")
        return
    observed["control_requests_verified"] += len(rows)


def search_page_contains_target(
    body: Mapping[str, Any],
    kind: str,
    oracle: tuple[Any, ...],
    *,
    offset: int,
    step: str,
) -> bool:
    rows = validate_platform_page(body, 10, step, offset=offset)
    keys = {"kind", "id", "title", "context_label", "module_id", "board_id", "can_open"}
    if any(
        set(row) != keys
        or row["kind"] != kind
        or type(row["can_open"]) is not bool
        or not isinstance(row["title"], str)
        or not isinstance(row["context_label"], str)
        or (row["module_id"] is None) != (kind != "record")
        or (row["board_id"] is None) != (kind not in ("post", "event"))
        for row in rows
    ):
        raise SamplePhaseActionError("Search result shape differs", step=step)
    return any(
        tuple(row[key] for key in ("id", "title", "context_label", "module_id", "board_id"))
        == oracle
        and row["can_open"] is True
        for row in rows
    )
