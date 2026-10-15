"""Exact ordered payload objects shared by Sandbox test documents."""

from __future__ import annotations


def sandbox_document_payload(
    *,
    design: dict[str, object],
    triggers: list[dict[str, object]],
    scenarios: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "kind": "openslate-sandbox",
        "schemaVersion": 4,
        "design": design,
        "triggers": triggers,
        "scenarios": scenarios,
    }


def field_payload(
    field_id: str,
    name: str,
    field_type: str,
    *,
    config: dict[str, object],
) -> dict[str, object]:
    return {"id": field_id, "name": name, "type": field_type, "config": config}


def trigger_payload(
    trigger_id: str,
    name: str,
    *,
    enabled: bool,
    priority: int,
    trigger: dict[str, object],
    condition_group: dict[str, object],
    actions: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "id": trigger_id,
        "name": name,
        "enabled": enabled,
        "priority": priority,
        "trigger": trigger,
        "conditionGroup": condition_group,
        "actions": actions,
    }
