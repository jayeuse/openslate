"""Stored resolution and write admission; no settings writer/API."""

import pytest
from fastapi import HTTPException

from app.systems.comms.access import can_start_direct
from app.systems.comms.settings.resolution import resolve_settings, validate_settings_patch
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.records.models import Record
from tests.rbac.support import add_module

pytestmark = pytest.mark.integration


def test_layers_keep_false_zero_empty_null_and_explain_tolerant_inheritance(policy_case):
    c, db = policy_case, policy_case.db
    channel = c.conversation(category=c.category)
    workspace = {"kind": "workspace"}
    category = {"kind": "category", "id": c.category.id}
    local = {"kind": "channel", "id": channel.id}
    module = add_module(db, c.department)
    record = Record(org_id=c.org.id, module_id=module.id, data={})
    db.add(record)
    db.flush()
    c.settings(
        workspace,
        {
            "formatting": True,
            "edit_window_minutes": 45,
            "max_file_size_mb": 5,
            "allowed_file_types": ["pdf"],
            "pinned_record_id": str(record.id),
            "quiet_hours_start": "22:00",
            "quiet_hours_end": "06:00",
            "dm_rule": "none",
        },
    )
    middle = c.settings(
        category,
        {
            "formatting": False,
            "edit_window_minutes": 0,
            "max_file_size_mb": 0,
            "allowed_file_types": [],
            "pinned_record_id": None,
            "quiet_hours_start": "",
            "quiet_hours_end": "",
        },
    )
    stored = c.settings(
        local,
        {
            "edit_window_minutes": "legacy",
            "unknown_legacy_setting": True,
            "quiet_hours_start": "25:00",
            "quiet_hours_end": "03:00",
        },
    )
    resolved = resolve_settings(db, local)
    assert {
        key: resolved["effective"][key]
        for key in (
            "formatting",
            "edit_window_minutes",
            "max_file_size_mb",
            "allowed_file_types",
            "pinned_record_id",
            "quiet_hours_start",
            "quiet_hours_end",
        )
    } == {
        "formatting": False,
        "edit_window_minutes": 0,
        "max_file_size_mb": 0,
        "allowed_file_types": [],
        "pinned_record_id": None,
        "quiet_hours_start": "",
        "quiet_hours_end": "",
    }
    assert resolved["sources"]["edit_window_minutes"] == category
    assert resolved["sources"]["pinned_record_id"] == category  # null is an explicit clear here.
    assert resolved["sources"]["link_previews"] == {"kind": "default"}
    assert resolved["effective"]["link_previews"] is False
    assert resolved["overrides"] == {}
    assert "unknown_legacy_setting" not in resolved["effective"]
    assert "unknown_legacy_setting" in stored.values  # Reads do not rewrite stored legacy data.
    assert resolve_settings(db, workspace)["dm_rule"] == "none"
    c.lock("setting", "formatting")
    locked = resolve_settings(db, local)
    assert locked["effective"]["formatting"] is True
    assert locked["sources"]["formatting"] == workspace
    assert "formatting" in locked["locked_keys"]
    # Ordinary reset means removal; unlike retention, null is not a reset command.
    middle.values = {
        key: value for key, value in middle.values.items() if key != "edit_window_minutes"
    }
    db.flush()
    inherited = resolve_settings(db, local)
    assert inherited["effective"]["edit_window_minutes"] == 45
    assert inherited["sources"]["edit_window_minutes"] == workspace
    middle.values = {**middle.values, "edit_window_minutes": None}
    db.flush()
    assert resolve_settings(db, local)["effective"]["edit_window_minutes"] == 45


def test_strict_admission_keeps_explicit_values_and_platform_ceilings_without_writing(policy_case):
    c, db = policy_case, policy_case.db
    scope = {"kind": "category", "id": c.category.id}
    row = c.settings(scope, {"formatting": True})
    patch = {
        "formatting": False,
        "edit_window_minutes": 0,
        "max_file_size_mb": 0,
        "allowed_file_types": [],
        "allowed_reactions": [],
        "pinned_record_id": None,
        "quiet_hours_start": "",
        "quiet_hours_end": "",
    }
    assert validate_settings_patch(db, scope, patch) == patch
    ceiling = {"max_file_size_mb": 10, "allowed_file_types": ["pdf", "png", "docx"]}
    assert validate_settings_patch(db, scope, ceiling) == ceiling
    overnight = {"quiet_hours_start": "22:00", "quiet_hours_end": "06:00"}
    assert validate_settings_patch(db, scope, overnight) == overnight
    invalid = [
        {"legacy_permission": True},
        {"formatting": "false"},
        {"edit_window_minutes": None},
        {"edit_window_minutes": -1},
        {"max_file_size_mb": 10.01},
        {"allowed_file_types": ["exe"]},
        {"quiet_hours_start": "22:00"},
        {"quiet_hours_start": "", "quiet_hours_end": "06:00"},
        {"message_days": 0},
        {"dm_rule": "none"},
    ]
    for payload in invalid:
        with pytest.raises(HTTPException) as refused:
            validate_settings_patch(db, scope, payload)
        assert refused.value.status_code == 422
    c.lock("setting", "formatting")
    with pytest.raises(HTTPException) as refused:
        validate_settings_patch(db, scope, {"formatting": False})
    assert refused.value.status_code == 403
    c.lock("setting", "pinned_record_id")
    with pytest.raises(HTTPException) as refused:
        validate_settings_patch(db, scope, {"pinned_record_id": None})
    assert refused.value.status_code == 403  # Absent override is not an explicit clear.
    db.refresh(row)
    assert row.values == {"formatting": True}
    assert not db.new and not db.dirty and not db.deleted


def test_workspace_dm_rule_is_writable_and_controls_current_direct_admission(policy_case):
    c, db = policy_case, policy_case.db
    workspace = {"kind": "workspace"}
    row = c.settings(workspace, {})
    direct = c.conversation(kind="direct")
    c.member(direct, c.actor)
    c.member(direct, c.peer)
    assert resolve_settings(db, workspace)["dm_rule"] == "everyone"
    for rule, can_start in (("none", False), ("shared-channel", False), ("everyone", True)):
        patch = validate_settings_patch(db, workspace, {"dm_rule": rule})
        assert patch == {"dm_rule": rule}
        row.values = patch
        db.flush()
        resolved = resolve_settings(db, workspace)
        assert resolved["dm_rule"] == rule
        # The existing wire contract keeps direct policy outside inherited settings.
        for key in ("effective", "overrides", "sources"):
            assert "dm_rule" not in resolved[key]
        assert all(item["key"] != "dm_rule" for item in resolved["metadata"])
        assert can_start_direct(db, c.actor, c.peer.id) is can_start
    row.values = validate_settings_patch(db, workspace, {"dm_rule": "shared-channel"})
    c.conversation(scope="organization")
    assert can_start_direct(db, c.actor, c.peer.id) is True


def test_dm_rule_rejects_invalid_values_and_lower_scopes_without_writing(policy_case):
    c, db = policy_case, policy_case.db
    workspace = {"kind": "workspace"}
    row = c.settings(workspace, {"dm_rule": "none"})
    channel = c.conversation(category=c.category)
    category_scope = {"kind": "category", "id": c.category.id}
    channel_scope = {"kind": "channel", "id": channel.id}
    for value in ("unknown", None, True, []):
        with pytest.raises(HTTPException) as refused:
            validate_settings_patch(db, workspace, {"dm_rule": value})
        assert refused.value.status_code == 422
    for scope in (category_scope, channel_scope):
        with pytest.raises(HTTPException) as refused:
            validate_settings_patch(db, scope, {"dm_rule": "everyone"})
        assert refused.value.status_code == 422
        c.settings(scope, {"dm_rule": "everyone"})
        resolved = resolve_settings(db, scope)
        assert "dm_rule" not in resolved
        for key in ("effective", "overrides", "sources"):
            assert "dm_rule" not in resolved[key]
    db.refresh(row)
    assert row.values == {"dm_rule": "none"}
    assert resolve_settings(db, workspace)["dm_rule"] == "none"
    assert not db.new and not db.dirty and not db.deleted


def test_reference_admission_uses_real_bound_organization_rows(policy_case, foreign_references):
    c, db = policy_case, policy_case.db
    scope = {"kind": "category", "id": c.category.id}
    module = add_module(db, c.department)
    field = Field(org_id=c.org.id, module_id=module.id, name="Name", type="text", position=0)
    record = Record(org_id=c.org.id, module_id=module.id, data={})
    db.add_all([field, record])
    db.flush()
    valid = {
        "default_member_ids": [str(c.peer.id)],
        "restricted_person_ids": [str(c.peer.id)],
        "allowed_record_modules": [str(module.id)],
        "record_card_fields": [str(field.id)],
        "pinned_record_id": str(record.id),
    }
    # Admission returns a patch; the owner will later authorize, recheck and persist it.
    assert validate_settings_patch(db, scope, valid) == valid
    for key, value in (
        ("default_member_ids", [str(c.world.second.peer)]),
        ("restricted_person_ids", [str(c.world.second.peer)]),
        ("allowed_record_modules", [str(foreign_references["module"])]),
        ("record_card_fields", [str(foreign_references["field"])]),
        ("pinned_record_id", str(foreign_references["record"])),
    ):
        with pytest.raises(HTTPException) as refused:
            validate_settings_patch(db, scope, {key: value})
        assert refused.value.status_code == 422
    c.peer.status = "disabled"
    db.flush()
    with pytest.raises(HTTPException) as refused:
        validate_settings_patch(db, scope, {"default_member_ids": [str(c.peer.id)]})
    assert refused.value.status_code == 422
    foreign = {"kind": "category", "id": c.world.second.category}
    for operation in (
        lambda: resolve_settings(db, foreign),
        lambda: validate_settings_patch(db, foreign, {"formatting": False}),
    ):
        with pytest.raises(HTTPException) as refused:
            operation()
        assert refused.value.status_code == 404
