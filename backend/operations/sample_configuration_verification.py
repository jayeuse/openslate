"""API readback of Harbor workspace, Access, and published Sandbox configuration."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any, cast

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample_blueprint import SampleDataset
from operations.sample_client import SampleClient, SampleClientError
from operations.sample_people import _GROUP_ACCESS, _people
from operations.sample_verification import SampleVerificationError, list_all_rows

_FIELD_TYPES = {
    "Text": "text",
    "Long text": "long_text",
    "Number": "number",
    "Integer": "int",
    "Date": "date",
    "Date/Time": "datetime",
    "Checkbox": "boolean",
    "Select": "select",
    "Email": "email",
    "URL": "url",
    "User": "user",
}
_CARDINALITY = {
    "one-to-one": (False, False),
    "one-to-many": (True, False),
    "many-to-many": (True, True),
}


def _read_object(client: SampleClient, path: str) -> Mapping[str, Any]:
    response = client.request("GET", path)
    if response.status_code != 200:
        raise SampleVerificationError(f"GET {path} returned HTTP {response.status_code}")
    try:
        result = response.json()
    except ValueError:
        raise SampleVerificationError(f"GET {path} returned invalid JSON") from None
    if not isinstance(result, dict):
        raise SampleVerificationError(f"GET {path} returned an invalid object")
    return result


def _ids_match(rows: Sequence[Mapping[str, Any]], expected: Mapping[str, str]) -> bool:
    actual = [row.get("id") for row in rows]
    return len(actual) == len(expected) and set(actual) == set(expected.values())


def _group_issues(
    client: SampleClient,
    mappings: Mapping[str, Mapping[str, str]],
    people: Mapping[str, Mapping[str, Any]],
) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    groups = mappings.get("group", mappings.get("groups", {}))
    departments = mappings.get("departments", {})
    modules = mappings.get("modules", {})
    if set(groups) != set(_GROUP_ACCESS) or len(set(groups.values())) != len(_GROUP_ACCESS):
        issues.append("Access group ID mapping does not cover every planned group")
    rows = list_all_rows(client, "/api/access/groups")
    if not _ids_match(rows, groups):
        issues.append("live Access groups differ from the sample run")
    count = 0
    for slug, entries in _GROUP_ACCESS.items():
        group_id = groups.get(slug)
        if not group_id:
            continue
        row = _read_object(client, f"/api/access/groups/{group_id}")
        expected_members = {
            str(people.get(person.key, {}).get("user_id"))
            for person in _people()
            if slug in person.groups
        }
        expected_access = {
            (departments.get(department), modules.get(module) if module else None, level)
            for department, module, level in entries
        }
        members = row.get("member_ids")
        access = row.get("access")
        actual_access = (
            [
                (item.get("department_id"), item.get("module_id"), item.get("level"))
                for item in access
                if isinstance(item, dict)
            ]
            if isinstance(access, list)
            else []
        )
        expected_name = " ".join(word.capitalize() for word in slug.split("-"))
        if (
            row.get("id") != group_id
            or row.get("name") != expected_name
            or row.get("is_deleted") is not False
            or not isinstance(members, list)
            or len(members) != len(expected_members)
            or set(members) != expected_members
            or not isinstance(access, list)
            or len(actual_access) != len(expected_access)
            or set(actual_access) != expected_access
            or any(department_id is None for department_id, _, _ in expected_access)
            or any(module is not None and module not in modules for _, module, _ in entries)
        ):
            issues.append(f"Access group {slug} membership or permissions differ")
        else:
            count += 1
    return {"groups_verified": count}, issues


def _expected_config(field: Mapping[str, Any]) -> dict[str, Any]:
    config = field.get("config")
    if not isinstance(config, Mapping):
        return {}
    return {
        "minimum" if key == "min" else "maximum" if key == "max" else key: value
        for key, value in config.items()
        if key != "kind"
    }


def _structure_issues(
    client: SampleClient,
    dataset: SampleDataset,
    mappings: Mapping[str, Mapping[str, str]],
) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    design = cast(dict[str, Any], dataset.document["design"])
    departments = cast(list[dict[str, Any]], design["departments"])
    modules = cast(list[dict[str, Any]], design["modules"])
    relationships = cast(list[dict[str, Any]], design["relationships"])
    department_map = mappings.get("departments", {})
    module_map = mappings.get("modules", {})
    field_map = mappings.get("fields", {})
    relationship_map = mappings.get("relationships", {})
    if len(departments) != 6 or len(modules) != 24 or len(relationships) != 18:
        issues.append("generated Sandbox structure does not contain 6/24/18 definitions")
    live_departments = list_all_rows(client, "/api/departments")
    live_modules = list_all_rows(client, "/api/modules")
    live_fields = list_all_rows(client, "/api/fields")
    if not _ids_match(live_departments, department_map):
        issues.append("published department set differs from the generated design")
    if not _ids_match(live_modules, module_map):
        issues.append("published module set differs from the generated design")
    by_department = {row.get("id"): row for row in live_departments}
    by_module = {row.get("id"): row for row in live_modules}
    by_field = {row.get("id"): row for row in live_fields}
    department_key = {doc_id: key for key, doc_id in dataset.department_ids.items()}
    module_key = {doc_id: key for key, doc_id in dataset.module_ids.items()}
    for definition in departments:
        key = department_key.get(definition["id"])
        row = by_department.get(department_map.get(key or ""), {})
        if row.get("department_name") != definition["name"] or row.get("is_deleted") is not False:
            issues.append("a published department differs from the generated design")
    for definition in modules:
        key = module_key.get(definition["id"])
        row = by_module.get(module_map.get(key or ""), {})
        title_field_key = next(
            (
                field_key
                for field_key, document_id in dataset.field_ids.get(key or "", {}).items()
                if document_id == definition["titleFieldId"]
            ),
            None,
        )
        if (
            row.get("module_name") != definition["name"]
            or row.get("department_id")
            != department_map.get(department_key.get(definition["departmentId"], ""))
            or row.get("title_field_id") != field_map.get(f"{key}:{title_field_key}")
            or row.get("is_deleted") is not False
        ):
            issues.append("a published module differs from the generated design")
    expected_field_ids = set(field_map.values()) | set(relationship_map.values())
    if len(live_fields) != len(expected_field_ids) or set(by_field) != expected_field_ids:
        issues.append("published field and relationship definition set differs")
    field_count = 0
    position_by_source: dict[str, int] = {}
    for module in modules:
        key = module_key.get(module["id"], "")
        live_module_id = module_map.get(key)
        fields = cast(list[dict[str, Any]], module["fields"])
        position_by_source[module["id"]] = len(fields)
        for position, definition in enumerate(fields):
            field_key = next(
                (
                    name
                    for name, document_id in dataset.field_ids.get(key, {}).items()
                    if document_id == definition["id"]
                ),
                None,
            )
            row = by_field.get(field_map.get(f"{key}:{field_key}"), {})
            if (
                row.get("module_id") != live_module_id
                or row.get("name") != definition["name"]
                or row.get("type") != _FIELD_TYPES.get(definition["type"])
                or row.get("required") is not definition["required"]
                or row.get("position") != position
                or row.get("config") != _expected_config(definition)
                or row.get("is_deleted") is not False
                or row.get("relationship_target_module_id") is not None
                or row.get("relationship_multiple_targets") is not None
                or row.get("relationship_multiple_sources") is not None
            ):
                issues.append("a published primitive field or its configuration differs")
            else:
                field_count += 1
    relationship_key = {doc_id: key for key, doc_id in dataset.relationship_ids.items()}
    relation_count = 0
    for definition in relationships:
        key = relationship_key.get(definition["id"], "")
        source_id = definition["sourceModuleId"]
        target_key = module_key.get(definition["targetModuleId"], "")
        multiple_targets, multiple_sources = _CARDINALITY[definition["cardinality"]]
        row = by_field.get(relationship_map.get(key), {})
        relation_position = position_by_source.get(source_id)
        if (
            row.get("module_id") != module_map.get(module_key.get(source_id, ""))
            or row.get("name") != definition["name"]
            or row.get("type") != "relationship"
            or row.get("required") is not False
            or row.get("position") != relation_position
            or row.get("config") != {}
            or row.get("relationship_target_module_id") != module_map.get(target_key)
            or row.get("relationship_multiple_targets") is not multiple_targets
            or row.get("relationship_multiple_sources") is not multiple_sources
            or row.get("is_deleted") is not False
        ):
            issues.append("a published relationship definition differs")
        else:
            relation_count += 1
        if relation_position is not None:
            position_by_source[source_id] = relation_position + 1
    return {
        "departments_verified": len(departments)
        - sum("published department differs" in issue for issue in issues),
        "modules_verified": len(modules)
        - sum("published module differs" in issue for issue in issues),
        "fields_verified": field_count,
        "relationship_definitions_verified": relation_count,
    }, issues


def _sandbox_issues(
    client: SampleClient,
    dataset: SampleDataset,
    mappings: Mapping[str, Mapping[str, str]],
) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    workspace = _read_object(client, "/api/workspace")
    if any(
        workspace.get(key) != value
        for key, value in (
            ("display_name", "Harbor Operations Group"),
            ("locale", "en-US"),
            ("timezone", "Asia/Manila"),
        )
    ):
        issues.append("Workspace name, locale or timezone differs from Harbor sample settings")
    current = _read_object(client, "/api/sandbox/document")
    expected_document = SandboxDocument.model_validate(dataset.document).model_dump(
        mode="json", by_alias=True
    )
    versions = mappings.get("sandbox_versions", {})
    published = versions.get("published")
    latest = current.get("latestPublishedVersion")
    if current.get("document") != expected_document:
        issues.append("current Sandbox design or eight rules differ from the generated document")
    if (
        not isinstance(latest, Mapping)
        or latest.get("id") != published
        or not published
        or current.get("hasUnpublishedChanges") is not False
        or not current.get("contentHash")
        or current.get("publishedHash") != current.get("contentHash")
        or current.get("issues") != []
    ):
        issues.append("the current Sandbox design is not the expected published version")
    live_versions = list_all_rows(client, "/api/sandbox/versions")
    checkpoint = versions.get("initial_checkpoint")
    if (
        set(versions) != {"initial_checkpoint", "published"}
        or not checkpoint
        or not _ids_match(live_versions, versions)
        or {row.get("id"): row.get("kind") for row in live_versions}
        != {checkpoint: "checkpoint", published: "published"}
    ):
        issues.append("Sandbox checkpoint or publication history differs")
    else:
        for version_id in (checkpoint, published):
            detail = _read_object(client, f"/api/sandbox/versions/{version_id}")
            if (
                detail.get("document") != expected_document
                or detail.get("contentHash") != current.get("contentHash")
                or detail.get("isDeleted") is not False
            ):
                issues.append("a Sandbox version does not preserve the generated design")
    tests = list_all_rows(client, "/api/sandbox/tests")
    test_ids = mappings.get("sandbox_tests", {})
    by_id = {row.get("id"): row for row in tests}
    if (
        len(dataset.test_vectors) != 8
        or set(test_ids) != {vector.key.replace("-", "_") for vector in dataset.test_vectors}
        or not _ids_match(tests, test_ids)
    ):
        issues.append("Sandbox Test history does not cover eight saved runs")
    verified_tests = 0
    for vector in dataset.test_vectors:
        row = by_id.get(test_ids.get(vector.key.replace("-", "_")), {})
        result = row.get("result")
        event = row.get("event")
        normalized_event = (
            {key: value for key, value in event.items() if value is not None}
            if isinstance(event, Mapping)
            else event
        )
        if (
            row.get("input")
            != {"moduleId": dataset.module_ids[vector.module_key], "values": vector.values}
            or normalized_event != vector.event
            or row.get("triggerIds") != list(vector.trigger_ids)
            or not isinstance(result, Mapping)
        ):
            issues.append("a saved Sandbox Test differs from its authored input")
        else:
            verified_tests += 1
    return {
        "workspace_verified": int(not any(issue.startswith("Workspace") for issue in issues)),
        "sandbox_tests_verified": verified_tests,
        "sandbox_versions_verified": len(live_versions),
    }, issues


def verify_configuration(
    client: SampleClient,
    *,
    dataset: SampleDataset,
    mappings: Mapping[str, Mapping[str, str]],
    people: Mapping[str, Mapping[str, Any]],
) -> tuple[dict[str, int], list[str]]:
    """Compare every authored foundational setting with current authenticated API reads."""
    observed: dict[str, int] = {}
    issues: list[str] = []
    checks: tuple[Callable[[], tuple[dict[str, int], list[str]]], ...] = (
        lambda: _group_issues(client, mappings, people),
        lambda: _sandbox_issues(client, dataset, mappings),
        lambda: _structure_issues(client, dataset, mappings),
    )
    for check in checks:
        try:
            counts, findings = check()
        except (SampleClientError, SampleVerificationError, ValueError, TypeError, KeyError):
            issues.append("foundational configuration could not be read or was invalid")
            continue
        observed.update(counts)
        issues.extend(findings)
    return observed, issues
