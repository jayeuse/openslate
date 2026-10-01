"""Expected final configuration derived from a private run's recorded phase plan."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import fields, replace
from typing import TYPE_CHECKING, Any, cast

from operations.sample_blueprint import SampleDataset
from operations.sample_client import _SAFE_MAPPING_VALUE
from operations.sample_packs.interface import OrganizationPack
from operations.sample_verification import SampleVerificationError

if TYPE_CHECKING:
    from operations.sample_packs.phase_types import PhaseAction


def read_phase_plan(manifest: Mapping[str, Any]) -> tuple[PhaseAction, ...]:
    """Legacy manifests have no phase plan; malformed new plans fail closed."""
    if "phase_plan" not in manifest:
        return ()
    rows = manifest["phase_plan"]
    if not isinstance(rows, list):
        raise SampleVerificationError("Run phase plan is invalid")
    if not rows:
        return ()
    from operations.sample_packs.phase_types import PhaseAction

    expected = {field.name for field in fields(PhaseAction)}
    actions: list[PhaseAction] = []
    seen: set[str] = set()
    for row in rows:
        if (
            not isinstance(row, dict)
            or set(row) != expected
            or any(
                not isinstance(row.get(key), str) or not _SAFE_MAPPING_VALUE.fullmatch(row[key])
                for key in ("key", "kind", "actor_key", "target_key")
            )
            or row.get("phase") not in {"admin", "reorganization"}
            or not isinstance(row.get("values"), dict)
            or not isinstance(row.get("expected_end_state"), dict)
            or type(row.get("expected_status")) is not int
            or (
                row.get("expected_detail") is not None
                and not isinstance(row["expected_detail"], str)
            )
            or not 100 <= row["expected_status"] <= 599
            or row["key"] in seen
        ):
            raise SampleVerificationError("Run phase plan is invalid")
        seen.add(row["key"])
        try:
            actions.append(PhaseAction(**row))
        except (TypeError, ValueError):
            raise SampleVerificationError("Run phase plan is invalid") from None
    return tuple(actions)


def final_people_pack(
    organization: OrganizationPack, actions: Sequence[PhaseAction]
) -> OrganizationPack:
    """Project role, status and group changes without mutating original pack data."""
    if not actions:
        return organization
    from operations.sample_phases import phase_expected_projection

    projection = cast(Mapping[str, Any], phase_expected_projection(tuple(actions)))
    overrides = projection["people"]
    additions = projection["membership_additions"]
    removals = projection["membership_removals"]
    people = []
    for person in organization.actors.people:
        changed = overrides.get(person.key, {})
        groups = set(person.groups)
        groups.difference_update(group for group, key in removals if key == person.key)
        groups.update(group for group, key in additions if key == person.key)
        people.append(
            replace(
                person,
                role=changed.get("role", person.role),
                status=changed.get("status", person.status),
                groups=tuple(sorted(groups)),
            )
        )
    group_access = dict(organization.actors.group_access)
    for key, rows in projection["group_access"].items():
        group_access[key] = tuple(
            (row["department_key"], row["module_key"], row["level"]) for row in rows
        )
    return replace(
        organization,
        actors=replace(organization.actors, people=tuple(people), group_access=group_access),
    )


def final_configuration_dataset(
    dataset: SampleDataset, actions: tuple[PhaseAction, ...]
) -> tuple[SampleDataset, dict[str, dict[str, object]], str]:
    """Keep activity inputs intact while projecting the authored final design."""
    from operations.sample_phases import phase_expected_projection, phase_version_documents

    organization = final_people_pack(dataset.organization, actions)
    projection = cast(Mapping[str, Any], phase_expected_projection(actions))
    design = projection["design"]
    if not design:
        return replace(dataset, organization=organization), {}, "published"
    versions = phase_version_documents(dataset, actions)
    final_key = str(design["final_version_key"])
    modules = dict(dataset.module_ids)
    fields_by_module = {key: dict(values) for key, values in dataset.field_ids.items()}
    new_key = str(design["new_module_key"])
    modules[new_key] = str(design["new_module_id"])
    fields_by_module[new_key] = {str(design["title_field_key"]): str(design["title_field_id"])}
    fields_by_module[str(design["module_key"])][str(design["added_field_key"])] = str(
        design["added_field_id"]
    )
    return (
        replace(
            dataset,
            organization=organization,
            document=versions[final_key],
            module_ids=modules,
            field_ids=fields_by_module,
        ),
        versions,
        final_key,
    )


def phase_plan_summary(dataset: SampleDataset) -> dict[str, Any]:
    """Expose every deterministic phase target before any run writes."""
    from operations.sample_phases import phase_action_to_manifest, plan_phases

    actions = plan_phases(dataset)
    counts = Counter(action.phase for action in actions)
    return {
        "phase_plan": [phase_action_to_manifest(action) for action in actions],
        "phase_counts": {
            "admin": counts["admin"],
            "reorganization": counts["reorganization"],
            "refusals": sum(action.expected_status >= 400 for action in actions),
            "total": len(actions),
        },
    }
