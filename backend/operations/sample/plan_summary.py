"""Deterministic plan counts and the operator plan shown before population."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.episodes import plan_sessions
from operations.sample.history import plan_history


def build_plan_summary(dataset: SampleDataset) -> dict[str, Any]:
    """Return the deterministic catalogue counts shown before population."""
    from operations.sample.phases.expectations import phase_plan_summary

    return {
        **phase_plan_summary(dataset),
        "profile": dataset.profile,
        "seed": dataset.seed,
        "anchor_date": dataset.anchor_date.isoformat(),
        "department_count": len(dataset.department_ids),
        "module_count": len(dataset.module_ids),
        "relationship_definition_count": len(dataset.relationship_ids),
        "automation_count": len(dataset.trigger_ids),
        "test_vector_count": len(dataset.test_vectors),
        "operational_records": sum(dataset.module_counts.values()),
        "relationship_edges": len(dataset.edges),
        "module_counts": dict(dataset.module_counts),
        "supporting_counts": dict(dataset.organization.content.supporting_counts),
        "session_count": len(plan_sessions(dataset)),
        "writes_by_person": _writes_by_person(dataset),
        "planned_rejections": len(dataset.organization.rejections.activity_cases)
        + len(dataset.organization.rejections.closing_cases),
    }


def _writes_by_person(dataset: SampleDataset) -> dict[str, int]:
    """Planned creates, links by their actual writers, and history updates."""
    creators = {record.logical_id: record.creator_key for record in dataset.records}
    writes = Counter(creators.values())
    writes.update(edge.creator_key or creators[edge.target_record_id] for edge in dataset.edges)
    writes.update(
        step.updater_key for history in plan_history(dataset).values() for step in history.steps
    )
    return dict(sorted(writes.items()))


def print_plan(dataset: SampleDataset, preflight: Mapping[str, Any], mailpit_url: str) -> None:
    summary = build_plan_summary(dataset)
    print(dataset.organization.blueprint.plan_heading)
    print(f"local_instance={preflight['instance']}")
    print(f"schema_head={preflight['alembic_head']}")
    print(f"administrator_eligible={str(preflight['admin_eligible']).lower()}")
    print(f"organization={preflight.get('organization_slug')} "
          f"id={preflight.get('organization_id') or 'created at population'}")
    print(f"organization_members_other_than_admin={preflight.get('organization_members', 0)}")
    print(f"organization_records={preflight.get('organization_records', 0)}")
    print(f"organization_storage_objects={preflight['storage_objects']}")
    print(f"pack_provider_accounts={preflight['provider_accounts']}")
    print(f"mailpit_ready=true ({mailpit_url})")
    print(
        f"profile={summary['profile']} seed={summary['seed']} anchor_date={summary['anchor_date']}"
    )
    print(
        "structure: "
        f"{summary['department_count']} departments, {summary['module_count']} modules, "
        f"{summary['relationship_definition_count']} relationship definitions, "
        f"{summary['automation_count']} automations, {summary['test_vector_count']} Sandbox tests"
    )
    print(f"operational_records={summary['operational_records']}")
    print("records_by_module:")
    for key, count in summary["module_counts"].items():
        print(f"  {key}={count}")
    print(f"record_relationship_edges={summary['relationship_edges']}")
    print(f"work_sessions={summary['session_count']}")
    print(f"planned_rejections={summary['planned_rejections']}")
    print(f"lifecycle_and_admin_actions={summary['phase_counts']['total']}")
    print(f"lifecycle_and_admin_refusals={summary['phase_counts']['refusals']}")
    print("writes_by_person:")
    for key, count in summary["writes_by_person"].items():
        print(f"  {key}={count}")
    print("fixed_supporting_data:")
    for key, count in summary["supporting_counts"].items():
        print(f"  {key}={count}")
    print(
        "prerequisites: an empty organization for this pack (other packs may hold data); "
        "matching admin credentials; "
        "invitations delivered only to owned Mailpit"
    )
    print(
        "exclusions: custom roles; "
        "service identities/metadata; access rules/defaults; "
        "saved chart preferences; direct database writes other than creating the pack "
        "organization; provider-admin user creation"
    )
    print(
        "No application data was changed. Population rechecks the complete API baseline "
        "before its first write."
    )
