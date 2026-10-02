"""Explicit UI run coverage and safe evidence from actual HTTP requests."""

from __future__ import annotations

import json
import os
import re
import stat
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import UUID

from operations.sample_journal import append_event

Route = tuple[str, str]

# This is deliberately independent of the frontend manifest: a new UI route
# must acquire an executor and verification before it can be added here.
SEEDER_ROUTES: frozenset[Route] = frozenset(
    {
        ("DELETE", "/api/access/groups/{group_id}"),
        ("DELETE", "/api/auth/invitations/{user_id}"),
        ("DELETE", "/api/auth/sessions/{session_id}"),
        ("DELETE", "/api/boards/{board_id}/events/{event_id}"),
        ("DELETE", "/api/boards/{board_id}/events/{event_id}/record-links/{link_id}"),
        ("DELETE", "/api/boards/{board_id}/posts/{post_id}"),
        ("DELETE", "/api/boards/{board_id}/posts/{post_id}/record-links/{link_id}"),
        ("DELETE", "/api/boards/{board_id}/widgets/{widget_id}"),
        ("DELETE", "/api/dashboards/{dashboard_id}"),
        ("DELETE", "/api/records/{record_id}"),
        ("DELETE", "/api/relationships/{relationship_id}"),
        ("DELETE", "/api/reports/{report_id}"),
        ("DELETE", "/api/sandbox/tests"),
        ("DELETE", "/api/sandbox/versions/{version_id}"),
        ("DELETE", "/api/users/{user_id}"),
        ("DELETE", "/api/users/{user_id}/sessions"),
        ("DELETE", "/api/users/{user_id}/sessions/{session_id}"),
        ("DELETE", "/api/views/{view_id}"),
        ("GET", "/api/access/groups"),
        ("GET", "/api/access/groups/{group_id}"),
        ("GET", "/api/access/member-candidates"),
        ("GET", "/api/audit-logs"),
        ("GET", "/api/audit-logs/options"),
        ("GET", "/api/audit-logs/{audit_log_id}"),
        ("GET", "/api/auth/me"),
        ("GET", "/api/auth/session"),
        ("GET", "/api/auth/sessions"),
        ("GET", "/api/boards"),
        ("GET", "/api/boards/{board_id}"),
        ("GET", "/api/boards/{board_id}/access-preview"),
        ("GET", "/api/boards/{board_id}/activity"),
        ("GET", "/api/boards/{board_id}/configuration"),
        ("GET", "/api/boards/{board_id}/events"),
        ("GET", "/api/boards/{board_id}/events/mine"),
        ("GET", "/api/boards/{board_id}/events/occurrences"),
        ("GET", "/api/boards/{board_id}/events/{event_id}"),
        ("GET", "/api/boards/{board_id}/events/{event_id}/record-links"),
        ("GET", "/api/boards/{board_id}/groups"),
        ("GET", "/api/boards/{board_id}/my-access"),
        ("GET", "/api/boards/{board_id}/post-authors"),
        ("GET", "/api/boards/{board_id}/posts"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/manage-state"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/record-links"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/revisions"),
        ("GET", "/api/boards/{board_id}/posts/{post_id}/revisions/{revision_id}"),
        ("GET", "/api/boards/{board_id}/preview-users"),
        ("GET", "/api/boards/{board_id}/widgets"),
        ("GET", "/api/dashboards"),
        ("GET", "/api/dashboards/{dashboard_id}"),
        ("GET", "/api/departments"),
        ("GET", "/api/events"),
        ("GET", "/api/fields"),
        ("GET", "/api/modules"),
        ("GET", "/api/modules/{module_id}/assignable-users"),
        ("GET", "/api/records/{record_id}"),
        ("GET", "/api/relationships"),
        ("GET", "/api/reports"),
        ("GET", "/api/reports/shared-runs"),
        ("GET", "/api/reports/{report_id}"),
        ("GET", "/api/reports/{report_id}/runs"),
        ("GET", "/api/reports/{report_id}/runs/{run_id}"),
        ("GET", "/api/reports/{report_id}/runs/{run_id}/csv"),
        ("GET", "/api/reports/{report_id}/schedule"),
        ("GET", "/api/sandbox/document"),
        ("GET", "/api/sandbox/export"),
        ("GET", "/api/sandbox/tests"),
        ("GET", "/api/sandbox/tests/{run_id}"),
        ("GET", "/api/sandbox/trigger-runs"),
        ("GET", "/api/sandbox/versions"),
        ("GET", "/api/sandbox/versions/{version_id}"),
        ("GET", "/api/users"),
        ("GET", "/api/users/{user_id}"),
        ("GET", "/api/users/{user_id}/access"),
        ("GET", "/api/users/{user_id}/sessions"),
        ("GET", "/api/views"),
        ("GET", "/api/views/data-sources"),
        ("GET", "/api/views/data-sources/{module_id}/fields"),
        ("GET", "/api/views/{view_id}"),
        ("GET", "/api/workspace"),
        ("PATCH", "/api/access/groups/{group_id}"),
        ("PATCH", "/api/boards/{board_id}"),
        ("PATCH", "/api/boards/{board_id}/events/{event_id}"),
        ("PATCH", "/api/boards/{board_id}/posts/{post_id}"),
        ("PATCH", "/api/boards/{board_id}/widgets/{widget_id}"),
        ("PATCH", "/api/dashboards/{dashboard_id}"),
        ("PATCH", "/api/records/{record_id}"),
        ("PATCH", "/api/reports/{report_id}"),
        ("PATCH", "/api/reports/{report_id}/schedule"),
        ("PATCH", "/api/sandbox/versions/{version_id}"),
        ("PATCH", "/api/users/{user_id}"),
        ("PATCH", "/api/views/{view_id}"),
        ("PATCH", "/api/workspace"),
        ("POST", "/api/access/groups"),
        ("POST", "/api/auth/invitations"),
        ("POST", "/api/auth/invitations/complete"),
        ("POST", "/api/auth/invitations/{user_id}/resend"),
        ("POST", "/api/auth/login"),
        ("POST", "/api/auth/logout"),
        ("POST", "/api/auth/password/change"),
        ("POST", "/api/auth/recovery/complete"),
        ("POST", "/api/auth/recovery/request"),
        ("POST", "/api/auth/refresh"),
        ("POST", "/api/auth/sessions/revoke-others"),
        ("POST", "/api/boards"),
        ("POST", "/api/boards/import"),
        ("POST", "/api/boards/{board_id}/archive"),
        ("POST", "/api/boards/{board_id}/duplicate"),
        ("POST", "/api/boards/{board_id}/events"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/archive"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/record-links"),
        ("POST", "/api/boards/{board_id}/events/{event_id}/restore"),
        ("POST", "/api/boards/{board_id}/posts"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/archive"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/publish"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/record-links"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/restore"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/schedule"),
        ("POST", "/api/boards/{board_id}/posts/{post_id}/unpublish"),
        ("POST", "/api/boards/{board_id}/purge"),
        ("POST", "/api/boards/{board_id}/purge/preview"),
        ("POST", "/api/boards/{board_id}/restore"),
        ("POST", "/api/boards/{board_id}/widgets"),
        ("POST", "/api/boards/{board_id}/widgets/{widget_id}/duplicate"),
        ("POST", "/api/dashboards"),
        ("POST", "/api/dashboards/{dashboard_id}/restore"),
        ("POST", "/api/records"),
        ("POST", "/api/records/aggregate-query"),
        ("POST", "/api/records/aggregate-snapshot"),
        ("POST", "/api/records/grouped-query"),
        ("POST", "/api/records/query"),
        ("POST", "/api/records/window-query"),
        ("POST", "/api/records/{record_id}/purge"),
        ("POST", "/api/records/{record_id}/purge/preview"),
        ("POST", "/api/records/{record_id}/restore"),
        ("POST", "/api/relationships"),
        ("POST", "/api/reports"),
        ("POST", "/api/reports/{report_id}/restore"),
        ("POST", "/api/reports/{report_id}/runs"),
        ("POST", "/api/reports/{report_id}/schedule"),
        ("POST", "/api/sandbox/imports"),
        ("POST", "/api/sandbox/publication-previews"),
        ("POST", "/api/sandbox/publications"),
        ("POST", "/api/sandbox/tests"),
        ("POST", "/api/sandbox/versions"),
        ("POST", "/api/sandbox/versions/{version_id}/restorations"),
        ("POST", "/api/users/{user_id}/restore"),
        ("POST", "/api/views"),
        ("POST", "/api/views/{view_id}/restore"),
        ("PUT", "/api/access/groups/{group_id}/access"),
        ("PUT", "/api/access/groups/{group_id}/members"),
        ("PUT", "/api/boards/{board_id}/groups"),
        ("PUT", "/api/boards/{board_id}/widgets/order"),
        ("PUT", "/api/relationships/fields/{field_id}/sources/{source_record_id}"),
        ("PUT", "/api/sandbox/document"),
    }
)

# Exact operations only; a category is never a prefix wildcard.
DEFERRED_ROUTES: dict[Route, str] = {
    ("DELETE", "/api/boards/{board_id}/events/{event_id}/attachments/{file_id}"): "files",
    ("DELETE", "/api/boards/{board_id}/posts/{post_id}/attachments/{file_id}"): "files",
    ("GET", "/api/boards/{board_id}/events/{event_id}/attachments"): "files",
    ("GET", "/api/boards/{board_id}/events/{event_id}/attachments/{file_id}/content"): "files",
    ("GET", "/api/boards/{board_id}/files/{file_id}"): "files",
    ("GET", "/api/boards/{board_id}/posts/{post_id}/attachments"): "files",
    ("GET", "/api/boards/{board_id}/posts/{post_id}/attachments/{file_id}/content"): "files",
    ("GET", "/api/notifications"): "notifications",
    ("POST", "/api/boards/{board_id}/events/{event_id}/attachments"): "files",
    ("POST", "/api/boards/{board_id}/files"): "files",
    ("POST", "/api/boards/{board_id}/files/{file_id}/scan"): "files",
    ("POST", "/api/boards/{board_id}/posts/{post_id}/attachments"): "files",
    ("POST", "/api/notifications/{notification_id}/read"): "notifications",
    ("PUT", "/api/boards/{board_id}/files/{file_id}/content"): "files",
}


@lru_cache(maxsize=1)
def _patterns() -> tuple[tuple[str, str, re.Pattern[str]], ...]:
    routes = sorted(
        SEEDER_ROUTES | DEFERRED_ROUTES.keys(), key=lambda row: (row[1].count("{"), row)
    )
    return tuple(
        (
            method,
            path,
            re.compile("^" + re.sub(r"\\\{[^{}]+\\\}", "[^/]+", re.escape(path)) + "$"),
        )
        for method, path in routes
    )


def route_template(method: str, path: str) -> str | None:
    """Return only a known template; never persist path, query or body values."""
    return next(
        (
            template
            for candidate, template, pattern in _patterns()
            if candidate == method.upper() and pattern.fullmatch(path)
        ),
        None,
    )


def _attempt_id(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("The route journal has an invalid attempt ID")
    try:
        return str(UUID(value))
    except ValueError:
        raise ValueError("The route journal has an invalid attempt ID") from None


def read_route_evidence(journal: Path) -> dict[str, Any]:
    """Count successful operations; planned or failed writes cannot claim coverage."""
    started: dict[str, Route | None] = {}
    finished: set[str] = set()
    covered: Counter[Route] = Counter()
    failures: Counter[str] = Counter()
    descriptor = os.open(journal, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or (
            os.name != "nt"
            and (metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077)
        ):
            raise ValueError("Route evidence must be an owner-only regular file")
        for line in stream:
            if len(line) > 4096:
                raise ValueError("The route journal contains an oversized entry")
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError("The route journal contains an invalid entry")
            event = row.get("event")
            if event not in {"request_started", "request_finished"}:
                continue
            attempt = _attempt_id(row.get("attempt_id"))
            if event == "request_started":
                if attempt in started:
                    raise ValueError("The route journal repeats an attempt ID")
                method, template = row.get("method"), row.get("route_template")
                route = (
                    (method, template)
                    if isinstance(method, str) and isinstance(template, str)
                    else None
                )
                if (
                    route is not None
                    and route not in SEEDER_ROUTES
                    and route not in DEFERRED_ROUTES
                ):
                    raise ValueError("The route journal claims an unknown operation")
                started[attempt] = route
                continue
            if attempt not in started or attempt in finished:
                raise ValueError("The route journal has an unmatched result")
            finished.add(attempt)
            status = row.get("status_code")
            if (
                type(status) is int
                and 200 <= status < 300
                and row.get("outcome") in {None, "resync_received"}
            ):
                if (route := started[attempt]) is not None:
                    covered[route] += 1
            elif type(status) is int and status >= 500:
                code = row.get("failure_code", "other")
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,64}", code):
                    raise ValueError("The route journal contains an invalid failure code")
                failures[code] += 1
    if started.keys() != finished:
        raise ValueError("The route journal has an unfinished request")
    return {
        "covered": [
            {"method": method, "path": path, "requests": count}
            for (method, path), count in sorted(covered.items())
        ],
        "uncovered": [
            {"method": method, "path": path}
            for method, path in sorted(SEEDER_ROUTES - covered.keys())
        ],
        "deferred": [
            {"method": method, "path": path, "reason": reason}
            for (method, path), reason in sorted(DEFERRED_ROUTES.items())
        ],
        "failures_5xx": dict(sorted(failures.items())),
    }


def verify_route_coverage(directory: Path) -> tuple[dict[str, int], list[str]]:
    """Require executed UI coverage across population and its read-only verification."""
    requests: Counter[Route] = Counter()
    failures: Counter[str] = Counter()
    try:
        for name in ("requests.jsonl", "invitation-requests.jsonl", "verification-requests.jsonl"):
            evidence = read_route_evidence(directory / name)
            for row in evidence["covered"]:
                requests[(row["method"], row["path"])] += row["requests"]
            failures.update(evidence["failures_5xx"])
    except (OSError, ValueError, UnicodeError):
        return {}, ["Actual UI route evidence is missing, unfinished or invalid"]
    missing = SEEDER_ROUTES - requests.keys()
    report = {
        "event": "route_coverage",
        "covered": [
            {"method": method, "path": path, "requests": requests[(method, path)]}
            for method, path in sorted(SEEDER_ROUTES & requests.keys())
        ],
        "deferred": [
            {"method": method, "path": path, "reason": category}
            for (method, path), category in sorted(DEFERRED_ROUTES.items())
        ],
        "uncovered": [{"method": method, "path": path} for method, path in sorted(missing)],
        "failures_5xx": dict(sorted(failures.items())),
    }
    try:
        append_event(directory / "route-coverage.jsonl", report)
    except OSError:
        return {}, ["Actual UI route coverage report could not be saved"]
    return (
        {
            "ui_routes_covered": len(SEEDER_ROUTES) - len(missing),
            "ui_routes_deferred": len(DEFERRED_ROUTES),
            "ui_routes_uncovered": len(missing),
            "http_5xx": sum(failures.values()),
        },
        [
            f"A required UI route was not exercised: {method} {path}"
            for method, path in sorted(missing)
        ],
    )
