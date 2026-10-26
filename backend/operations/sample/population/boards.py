"""Sample Board structures and project access."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from operations.sample.board_text import project_board
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack
from operations.sample.population.content import (
    SampleContentError,
    _attachment_count,
    _id,
    _json,
    _link_count,
    _pages,
)


def project_board_logical_id(department_key: str, name: str) -> str:
    """The run journal's ID for a project Board: the name as a lowercase slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")
    return f"project:{department_key}:{slug}"


def replace_project_board_groups(
    admin: SampleClient,
    board_id: str,
    department_key: str,
    groups: Mapping[str, str],
    *,
    organization: OrganizationPack | None = None,
) -> Mapping[str, Any]:
    spec = (organization or default_pack()).content.data
    if department_key not in spec.department_groups:
        raise SampleContentError(f"Unknown department for project Board access: {department_key}")
    department_group, department_level = spec.department_groups[department_key]
    grants = (*spec.project_groups, (department_group, department_level))
    slugs = tuple(slug for slug, _ in grants)
    if any(not groups.get(slug) for slug in slugs):
        raise SampleContentError("Required project Board access groups are unavailable")
    path = f"/api/boards/{board_id}/groups"
    current = _json(admin, "GET", path)
    revision = current.get("revision")
    if current.get("board_id") != board_id or not isinstance(revision, int):
        raise SampleContentError("Project Board group revision could not be read")
    wanted = [{"group_id": groups[slug], "level": level} for slug, level in grants]
    response = _json(admin, "PUT", path, body={"revision": revision, "groups": wanted})
    if response.get("board_id") != board_id or not isinstance(response.get("revision"), int):
        raise SampleContentError("Project Board access response did not match the requested Board")
    return response


def _authors(
    admin: SampleClient,
    clients: Mapping[str, SampleClient],
    board: Mapping[str, Any],
    organization: OrganizationPack,
) -> tuple[str, ...]:
    """Team members who can write on the Board; the Company Board is written by admin."""
    department_key = board.get("department_key")
    if department_key is None:
        return ("admin",)
    authors = []
    for key in organization.actors.team_keys[str(department_key)]:
        client = clients.get(key)
        if client is None:
            continue
        response = client.request("GET", f"/api/boards/{board['id']}")
        if response.status_code == 200 and response.json().get("level") in {"write", "manage"}:
            authors.append(key)
        elif response.status_code not in {403, 404}:
            _json(client, "GET", f"/api/boards/{board['id']}")
    if not authors:
        admin.record_mapping("content_fallback", str(board["logical_id"]), _id(board["board"]))
        return ("admin",)
    return tuple(authors)


def _create_project_boards(
    admin: SampleClient,
    departments: Mapping[str, Mapping[str, Any]],
    groups: Mapping[str, str],
    organization: OrganizationPack,
) -> list[dict[str, Any]]:
    result = []
    for name, department_key in organization.content.data.projects:
        if department_key not in departments:
            raise SampleContentError(f"Project Board department is unavailable: {department_key}")
        created = _json(
            admin,
            "POST",
            "/api/boards",
            body={
                "name": project_board(name, organization=organization)[0],
                "description": project_board(name, organization=organization)[1],
            },
            expected=(201,),
        )
        board_id = _id(created)
        logical = project_board_logical_id(department_key, name)
        admin.record_mapping("boards", logical, board_id)
        replace_project_board_groups(
            admin, board_id, department_key, groups, organization=organization
        )
        result.append(
            {
                "id": board_id,
                "logical_id": logical,
                "board": created,
                "department_key": department_key,
                "name": created.get("name", name),
                "scope": "project",
            }
        )
    return result


def prepare_boards(
    admin: SampleClient,
    *,
    clients: Mapping[str, SampleClient],
    departments: Mapping[str, Mapping[str, Any]],
    modules: Mapping[str, Mapping[str, Any]],
    groups: Mapping[str, str],
    organization: OrganizationPack | None = None,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Set up Boards before people work: project Boards and their access."""
    pack = organization or default_pack()
    spec = pack.content.data
    required_groups = {
        *(slug for slug, _ in spec.project_groups),
        *(slug for slug, _ in spec.department_groups.values()),
    }
    if required_groups - groups.keys():
        raise SampleContentError("Sample access groups are incomplete for project Boards")
    for module_key, department_key in spec.required_modules:
        if module_key not in modules or department_key not in departments:
            raise SampleContentError(f"Required scenario module is unavailable: {module_key}")
    if len(departments) != len(pack.catalog.departments) or len(modules) != len(
        pack.catalog.modules
    ):
        raise SampleContentError("The organization pack's approved structure is required")

    board_rows = _pages(
        admin,
        "/api/boards",
        {"status": "all", "sort_by": "name", "sort_order": "asc"},
    )
    company_rows = [board for board in board_rows if board.get("scope") == "company"]
    if len(company_rows) != 1:
        raise SampleContentError("Expected one built-in Company Board before Board population")
    department_ids = {key: _id(value) for key, value in departments.items()}
    by_department: dict[str, list[Mapping[str, Any]]] = {key: [] for key in departments}
    for board in board_rows:
        if board.get("scope") != "department":
            continue
        matches = [
            key
            for key, identity in department_ids.items()
            if board.get("department_id") == identity
        ]
        if len(matches) != 1:
            raise SampleContentError("Department Board does not match the published departments")
        by_department[matches[0]].append(board)
    if (
        any(len(items) != 1 for items in by_department.values())
        or len(board_rows) != len(departments) + 1
    ):
        raise SampleContentError("Expected one Company Board and one Board per department")

    board_specs: list[dict[str, Any]] = []
    company = company_rows[0]
    admin.record_mapping("boards", "company", _id(company))
    board_specs.append(
        {
            "id": _id(company),
            "logical_id": "company",
            "board": company,
            "department_key": None,
            "name": str(company.get("name", "Company")),
            "scope": "company",
        }
    )
    for key in departments:
        row = by_department[key][0]
        logical = f"department:{key}"
        admin.record_mapping("boards", logical, _id(row))
        board_specs.append(
            {
                "id": _id(row),
                "logical_id": logical,
                "board": row,
                "department_key": key,
                "name": str(row.get("name", key)),
                "scope": "department",
            }
        )
    board_specs.extend(_create_project_boards(admin, departments, groups, pack))
    for board in board_specs:
        board["authors"] = _authors(admin, clients, board, pack)
    return board_specs, {
        "boards": len(board_specs),
        "project_boards": len(spec.projects),
        "project_group_grants": sum(len(spec.project_groups) + 1 for _ in spec.projects),
    }


def verify_boards(
    admin: SampleClient,
    *,
    mappings: Mapping[str, Mapping[str, str]],
    organization: OrganizationPack | None = None,
) -> Mapping[str, int]:
    spec = (organization or default_pack()).content.data
    project_departments = {
        mappings.get("boards", {}).get(
            project_board_logical_id(department_key, name)
        ): department_key
        for name, department_key in spec.projects
    }
    group_ids = mappings.get("group", {})
    counts = {
        "boards": 0,
        "posts": 0,
        "events": 0,
        "reminders": 0,
        "files": 0,
        "record_links": 0,
        "project_group_grants": 0,
        "post_publications": 0,
        "publication_revisions": 0,
        "read_failures": 0,
    }
    try:
        boards = _pages(
            admin, "/api/boards", {"status": "all", "sort_by": "name", "sort_order": "asc"}
        )
    except (SampleClientError, SampleContentError):
        counts["read_failures"] += 1
        return counts
    counts["boards"] = len(boards)
    for board in boards:
        try:
            board_id = _id(board)
        except SampleContentError:
            counts["read_failures"] += 1
            continue
        base = f"/api/boards/{board_id}"
        try:
            posts = _pages(admin, f"{base}/posts", {"view": "editable"})
            posts.extend(_pages(admin, f"{base}/posts", {"view": "archive"}))
            events = _pages(admin, f"{base}/events", {"archived": "all"})
        except (SampleClientError, SampleContentError):
            counts["read_failures"] += 1
            continue
        counts["posts"] += len(posts)
        counts["events"] += len(events)
        for post in posts:
            post_id = _id(post)
            status = post.get("status")
            if status != "archived":
                view = "published" if status == "published" else "draft"
                path = f"{base}/posts/{post_id}/attachments"
                found, failed = _attachment_count(admin, path, view=view)
                counts["files"] += found
                counts["read_failures"] += failed
                found, failed = _link_count(
                    admin, f"{base}/posts/{post_id}/record-links", view=view
                )
                counts["record_links"] += found
                counts["read_failures"] += failed
            try:
                history = _json(admin, "GET", f"{base}/posts/{post_id}/revisions")
                revisions = history.get("items")
                if not isinstance(revisions, list):
                    raise SampleContentError("Post revision list is invalid")
                counts["post_publications"] += len(revisions)
                counts["publication_revisions"] += max(len(revisions) - 1, 0)
            except (SampleClientError, SampleContentError):
                counts["read_failures"] += 1
        for event in events:
            reminders = event.get("reminders")
            if isinstance(reminders, list):
                counts["reminders"] += len(reminders)
            event_id = _id(event)
            found, failed = _attachment_count(admin, f"{base}/events/{event_id}/attachments")
            counts["files"] += found
            counts["read_failures"] += failed
            found, failed = _link_count(admin, f"{base}/events/{event_id}/record-links")
            counts["record_links"] += found
            counts["read_failures"] += failed
        if board.get("scope") == "project":
            try:
                payload = _json(admin, "GET", f"{base}/groups")
                groups = payload.get("groups")
                if payload.get("board_id") != board_id or not isinstance(groups, list):
                    raise SampleContentError("Project Board group list is invalid")
                department_key = project_departments.get(board_id)
                if department_key is None:
                    raise SampleContentError("Project Board is absent from the run mapping")
                department_group, department_level = spec.department_groups[department_key]
                expected = {
                    (group_ids.get(slug), level)
                    for slug, level in (*spec.project_groups, (department_group, department_level))
                }
                if any(group_id is None for group_id, _ in expected):
                    raise SampleContentError(
                        "Intended project Board groups are absent from the run"
                    )
                actual = [
                    (group.get("group_id"), group.get("level"))
                    for group in groups
                    if isinstance(group, dict)
                ]
                matched = expected.intersection(actual)
                counts["project_group_grants"] += len(matched)
                if (
                    len(actual) != len(groups)
                    or len(actual) != len(expected)
                    or set(actual) != expected
                ):
                    counts["read_failures"] += 1
            except (SampleClientError, SampleContentError):
                counts["read_failures"] += 1
    return counts
