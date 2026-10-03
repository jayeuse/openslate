"""Generated OpenView request bodies validated by the application's current schemas."""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any, cast, get_type_hints
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import TypeAdapter, ValidationError

from app.systems.access.policy.schemas import GroupAccessReplace, GroupMembersReplace
from app.systems.access.users.schemas import UserUpdate
from app.systems.access.users.sessions_schemas import AdminSessionListRequest
from app.systems.boards.schemas import BoardCreate, BoardRevisionRequest
from app.systems.openview.dashboards.router import archive_dashboard
from app.systems.openview.dashboards.schemas import DashboardCreate, DashboardRestore
from app.systems.openview.reports.router import archive_report
from app.systems.openview.reports.schedule_schemas import ScheduleCreate
from app.systems.openview.reports.schemas import ReportCreate, ReportRevisionRequest
from app.systems.openview.views.router import archive_view
from app.systems.openview.views.schemas import ViewCreate, ViewRestore
from app.systems.sandbox.designs.schemas import (
    DocumentReplaceRequest,
    SandboxDocument,
    VersionCreateRequest,
    VersionMutationRequest,
)
from app.systems.sandbox.lifecycle.schemas import LifecyclePurgeRequest
from app.systems.sandbox.publications.rules import _field_type
from app.systems.sandbox.publications.schemas import (
    PublicationPreviewRequest,
    PublicationRequest,
)
from operations.sample_blueprint import SampleDataset
from operations.sample_board_text import dashboard_name, report_names, view_name
from operations.sample_client import _SAFE_MAPPING_VALUE
from operations.sample_openview import (
    _dashboard_widgets,
    _definition,
    _kind,
    _reference,
    _source_plans,
    _view_presentation,
)
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phases import phase_version_documents as phase_version_documents


def _api_structures(
    dataset: SampleDataset, document: SandboxDocument
) -> tuple[
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, list[Mapping[str, Any]]],
]:
    departments = {
        key: {"id": dataset.department_ids[key], "name": name}
        for key, name in dataset.organization.catalog.departments
    }
    modules: dict[str, dict[str, Any]] = {}
    fields: dict[str, list[Mapping[str, Any]]] = {}
    keys_by_id = {value: key for key, value in dataset.module_ids.items()}
    for module in document.design.modules:
        module_key = keys_by_id[module.id]
        modules[module_key] = {"id": module.id, "department_id": module.department_id}
        field_rows: list[Mapping[str, Any]] = []
        for position, field in enumerate(module.fields):
            if not field.closed:
                field_rows.append(
                    {
                        "id": field.id,
                        "module_id": module.id,
                        "name": field.name,
                        "type": str(_field_type(field)),
                        "position": position,
                    }
                )
        fields[module_key] = field_rows
    return departments, modules, fields


def validate_openview_payloads(dataset: SampleDataset, document: SandboxDocument) -> dict[str, Any]:
    """Validate the generated View, Dashboard, Report and disabled Schedule requests."""
    pack = dataset.organization
    departments, modules, fields = _api_structures(dataset, document)
    plans = _source_plans(departments, modules, fields, organization=pack)
    for department_key, department in departments.items():
        sources = plans[department_key]
        module_key, module, selected_fields = sources[0]
        definition = _definition(selected_fields)
        for layout in pack.content.data.layouts:
            ViewCreate.model_validate(
                {
                    "module_id": module["id"],
                    "name": view_name(module_key, layout, organization=pack),
                    "is_default": False,
                    "definition": definition,
                    "presentation": _view_presentation(layout, selected_fields),
                }
            )
        DashboardCreate.model_validate(
            {
                "department_id": department["id"],
                "name": dashboard_name(str(department["name"]), organization=pack),
                "position": 0,
                "refresh_cadence": "manual",
                "widgets": _dashboard_widgets(module, selected_fields),
            }
        )
        for index, (report_module_key, report_module, report_fields) in enumerate(sources):
            cadence = "daily" if index == 0 else "weekly"
            group_field = next((field for field in report_fields if _kind(field) == "select"), None)
            name, subtitle = report_names(
                report_module_key,
                cadence,
                str(group_field["name"]) if group_field else None,
                organization=pack,
            )
            ReportCreate.model_validate(
                {
                    "module_id": report_module["id"],
                    "name": name,
                    "subtitle": subtitle,
                    "recipe": {
                        "version": 1,
                        "fields": [_reference(field) for field in report_fields[:8]],
                        "filters": [],
                        "logic": "and",
                        "sorts": [],
                        "group_by": _reference(group_field) if group_field else None,
                        "include_row_count": True,
                    },
                }
            )
            ScheduleCreate.model_validate(
                {
                    "enabled": False,
                    "cadence": cadence,
                    "timezone_name": pack.identity.timezone,
                    "local_time": "09:00",
                    **({"weekday": 1} if cadence == "weekly" else {}),
                }
            )
    return cast(dict[str, Any], plans)


def _actor_ids(dataset: SampleDataset) -> dict[str, str]:
    namespace = dataset.organization.identity.uuid_namespace
    return {
        person.key: str(uuid5(NAMESPACE_URL, f"{namespace}:{dataset.seed}:actor:{person.key}"))
        for person in dataset.organization.actors.people
    }


def _validate_safe_phase_key_values(value: Any, *, action_key: str) -> None:
    if isinstance(value, Mapping):
        for name, child in value.items():
            if name.endswith("_key") and isinstance(child, str):
                assert _SAFE_MAPPING_VALUE.fullmatch(child), (action_key, name, child)
            elif name.endswith("_keys") and isinstance(child, list):
                assert all(
                    isinstance(item, str) and _SAFE_MAPPING_VALUE.fullmatch(item) for item in child
                ), (action_key, name)
            _validate_safe_phase_key_values(child, action_key=action_key)
    elif isinstance(value, list):
        for child in value:
            _validate_safe_phase_key_values(child, action_key=action_key)


def _validate_revision_query(endpoint: object) -> None:
    revision = get_type_hints(endpoint, include_extras=True)["revision"]
    adapter = TypeAdapter(revision)
    assert adapter.validate_python(1) == 1
    try:
        adapter.validate_python(0)
    except ValidationError:
        return
    raise AssertionError("OpenView archive revision query accepted a non-positive value")


def _validate_phase_versions(
    dataset: SampleDataset,
    actions: tuple[PhaseAction, ...],
    versions: dict[str, dict[str, object]],
) -> None:
    assert set(versions) == {
        "initial_checkpoint",
        "published",
        "control_lifecycle_published",
        "phase_design_edited",
        "phase_design_open",
        "phase_design_closed",
        "phase_design_reopened",
        "phase_before_restore_checkpoint",
        "phase_design_restored",
    }
    assert versions["initial_checkpoint"] == dataset.document
    assert versions["published"] == dataset.document

    spec = dataset.organization.phases
    assert spec is not None
    design = cast(dict[str, Any], dataset.document["design"])
    before_modules = cast(list[dict[str, Any]], design["modules"])
    modules_by_version = {
        key: {
            str(module["id"]): module
            for module in cast(list[dict[str, Any]], cast(dict[str, Any], doc)["design"]["modules"])
        }
        for key, doc in versions.items()
    }
    new_module_id = next(
        str(action.values["new_module_id"])
        for action in actions
        if action.kind == "sandbox_edit_publish"
    )
    original_module_ids = {str(module["id"]) for module in before_modules}
    edited_modules = modules_by_version["phase_design_edited"]
    opened_modules = modules_by_version["phase_design_open"]
    assert set(edited_modules) == original_module_ids
    assert set(opened_modules) == original_module_ids | {new_module_id}
    original = opened_modules[dataset.module_ids[spec.design.module_key]]
    assert original["name"] == spec.design.renamed_module_name
    original_fields = cast(list[dict[str, Any]], original["fields"])
    new_field_id = next(
        str(action.values["added_field_id"])
        for action in actions
        if action.kind == "sandbox_edit_publish"
    )
    assert new_field_id in {str(field["id"]) for field in original_fields}
    option_id = next(
        str(action.values["added_option_id"])
        for action in actions
        if action.kind == "sandbox_edit_publish"
    )
    select_field_id = dataset.field_ids[spec.design.module_key][spec.design.select_field_key]
    select_field = next(field for field in original_fields if field["id"] == select_field_id)
    options = cast(dict[str, Any], select_field["config"])["options"]
    assert option_id in {str(option["id"]) for option in cast(list[dict[str, Any]], options)}

    new_module = opened_modules[new_module_id]
    assert new_module["closed"] is False
    assert len(cast(list[dict[str, Any]], new_module["fields"])) == 1
    assert not any(record.module_key == spec.design.new_module_key for record in dataset.records)
    assert all(
        not edge.source_record_id.startswith(f"{spec.design.new_module_key}:")
        and not edge.target_record_id.startswith(f"{spec.design.new_module_key}:")
        for edge in dataset.edges
    )

    closed_doc = copy.deepcopy(versions["phase_design_closed"])
    closed_design = cast(dict[str, Any], closed_doc["design"])
    closed_module = next(
        module
        for module in cast(list[dict[str, Any]], closed_design["modules"])
        if module["id"] == new_module_id
    )
    assert closed_module["closed"] is True
    closed_module["closed"] = False
    assert closed_doc == versions["phase_design_open"]
    for key in (
        "phase_design_reopened",
        "phase_before_restore_checkpoint",
        "phase_design_restored",
    ):
        assert versions[key] == versions["phase_design_open"]


def validate_phase_request_payloads(
    dataset: SampleDataset, actions: tuple[PhaseAction, ...]
) -> dict[str, dict[str, object]]:
    """Validate planned phase bodies with their current request schemas."""
    versions = phase_version_documents(dataset, actions)
    assert all(_SAFE_MAPPING_VALUE.fullmatch(value) for value in versions)
    for document in versions.values():
        SandboxDocument.model_validate(document)
    _validate_phase_versions(dataset, actions, versions)

    actor_ids = _actor_ids(dataset)
    memberships = {person.key: set(person.groups) for person in dataset.organization.actors.people}
    for action in actions:
        assert _SAFE_MAPPING_VALUE.fullmatch(action.key), action.key
        assert _SAFE_MAPPING_VALUE.fullmatch(action.target_key), action.target_key
        assert _SAFE_MAPPING_VALUE.fullmatch(action.actor_key), action.actor_key
        _validate_safe_phase_key_values(action.values, action_key=action.key)
        _validate_safe_phase_key_values(action.expected_end_state, action_key=action.key)

        values = cast(dict[str, Any], action.values)
        if action.kind in {
            "refuse_role_change",
            "promote_user",
            "demote_user",
            "disable_user",
            "restore_disabled_user",
        }:
            field = "role" if "role" in values else "status"
            UserUpdate.model_validate({field: values[field]})
            if action.kind == "promote_user":
                for group_key in values["removed_group_keys"]:
                    memberships[action.target_key].discard(str(group_key))
        elif action.kind in {"remove_group_member", "add_group_member"}:
            group_key = str(
                values["source_group_key"]
                if action.kind == "remove_group_member"
                else values["destination_group_key"]
            )
            member_ids = [
                actor_ids[person.key]
                for person in dataset.organization.actors.people
                if group_key in memberships[person.key]
            ]
            GroupMembersReplace.model_validate({"member_ids": member_ids})
            if action.kind == "remove_group_member":
                memberships[action.target_key].discard(group_key)
            else:
                memberships[action.target_key].add(group_key)
        elif action.kind == "replace_group_access":
            entries = []
            for row in values["access"]:
                department_key = str(row["department_key"])
                module_key = row["module_key"]
                entries.append(
                    {
                        "department_id": dataset.department_ids[department_key],
                        "module_id": dataset.module_ids[str(module_key)]
                        if module_key is not None
                        else None,
                        "level": row["level"],
                    }
                )
            GroupAccessReplace.model_validate({"access": entries})
        elif action.kind == "end_session":
            AdminSessionListRequest.model_validate({})
            UUID(actor_ids[str(values["person_key"])])
        elif action.kind in {
            "refuse_board_archive",
            "board_archive",
            "board_restore",
            "board_archive_purge_target",
        }:
            BoardRevisionRequest.model_validate({"revision": 1})
        elif action.kind == "board_create_purge_target":
            BoardCreate.model_validate(
                {"name": values["display_name"], "description": values["description"]}
            )
        elif action.kind == "board_purge":
            LifecyclePurgeRequest.model_validate(
                {
                    "token": "offline-preflight-token",
                    "confirmation_name": action.target_key,
                    "password": "offline-preflight-password",
                }
            )
        elif action.kind in {"openview_archive", "openview_restore"}:
            resource_kind = values["resource_kind"]
            if action.kind == "openview_archive":
                endpoint = {
                    "view": archive_view,
                    "dashboard": archive_dashboard,
                    "report": archive_report,
                }[str(resource_kind)]
                _validate_revision_query(endpoint)
            elif resource_kind == "view":
                ViewRestore.model_validate({"revision": 1})
            elif resource_kind == "dashboard":
                DashboardRestore.model_validate({"revision": 1})
            else:
                ReportRevisionRequest.model_validate({"revision": 1})
        elif action.kind in {
            "sandbox_edit_publish",
            "sandbox_close_empty_publish",
            "sandbox_reopen_empty_publish",
            "sandbox_restore_publish",
        }:
            if action.kind == "sandbox_edit_publish":
                document_keys = [
                    str(values["edit_publish_version_key"]),
                    str(values["open_version_key"]),
                ]
            else:
                document_keys = [str(values["version_key"])]
            for version_key in document_keys:
                DocumentReplaceRequest.model_validate(
                    {"expectedRevision": 1, "document": versions[version_key]}
                )
                PublicationPreviewRequest.model_validate({"expectedRevision": 1})
                PublicationRequest.model_validate(
                    {
                        "expectedRevision": 1,
                        "previewToken": "offline-preflight-token",
                        "impactDigest": "0" * 64,
                        "password": "offline-preflight-password",
                        "note": "Publish the planned configuration.",
                    }
                )
            if action.kind == "sandbox_restore_publish":
                VersionCreateRequest.model_validate(
                    {
                        "expectedRevision": 1,
                        "kind": "checkpoint",
                        "label": "Before restore",
                        "note": "Save the current draft before restoring the planned open design.",
                    }
                )
                VersionMutationRequest.model_validate({"expectedRevision": 1})
        else:
            assert action.kind in {"refuse_board_archive", "board_purge_preview"}

    return versions
