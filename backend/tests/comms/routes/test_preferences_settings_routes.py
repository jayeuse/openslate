"""Shared settings retain conditional scope writes and inherited source/reset semantics."""

from threading import Barrier
from uuid import UUID

import pytest
from sqlalchemy import select

from app.systems.comms.settings.models import CommsSettings
from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.settings_support import stored
from tests.comms.routes.structure_support import (
    ROOT,
    _error,
    _ok,
    _race,
    _read,
    _tag,
    _unchanged_read,
)

pytestmark = pytest.mark.integration


def test_settings_inherit_lock_reset_and_audit_atomically_without_retention_backdoors(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    workspace = ROOT + "/settings/workspace"
    category = f"{ROOT}/settings/category/{org.category}"
    channel = f"{ROOT}/settings/channel/{org.conversation}"
    before = stored(case)
    for path in (workspace, category, channel):
        current = _read(admin, path)
        assert current.json()["overrides"] == {}
        _unchanged_read(admin, path, current)
    assert stored(case) == before
    for path, payload in (
        (workspace, {"formatting": True, "edit_window_minutes": 45}),
        (category, {"formatting": False, "edit_window_minutes": 15}),
        (channel, {"edit_window_minutes": 0, "delete_window_minutes": 12}),
    ):
        _ok(admin.patch(path, headers={"If-Match": _tag(_read(admin, path))}, json=payload))
    current = _read(admin, channel)
    assert current.json()["effective"]["formatting"] is False
    assert current.json()["sources"]["formatting"] == {"kind": "category", "id": str(org.category)}
    assert current.json()["effective"]["edit_window_minutes"] == 0
    old_workspace = _read(admin, workspace)
    _error(admin.put(workspace + "/locks", json={"keys": ["formatting"]}), 428)
    locked = admin.put(
        workspace + "/locks",
        headers={"If-Match": _tag(old_workspace)},
        json={"keys": ["formatting"]},
    )
    assert _ok(locked)["locked_keys"] == ["formatting"]
    _error(
        admin.put(
            workspace + "/locks", headers={"If-Match": _tag(old_workspace)}, json={"keys": []}
        ),
        412,
    )
    _error(
        peer.put(workspace + "/locks", headers={"If-Match": _tag(locked)}, json={"keys": []}), 403
    )
    current = _read(admin, channel)
    assert current.json()["effective"]["formatting"] is True
    assert current.json()["sources"]["formatting"] == {"kind": "workspace"}
    before = stored(case)
    for payload in (
        {"edit_window_minutes": 7, "file_previews": "false"},
        {"edit_window_minutes": 7, "quiet_hours_start": "22:00"},
        {"edit_window_minutes": 7, "message_days": 0},
        {"file_days": None},
        {"settings": {"formatting": True}},
        {"capability_locks": []},
        {"scope": {"kind": "workspace"}},
        {"dm_rule": "none"},
    ):
        _error(admin.patch(channel, headers={"If-Match": _tag(current)}, json=payload), 422)
        assert stored(case) == before
    _error(
        admin.patch(
            channel,
            headers={"If-Match": _tag(current)},
            json={"edit_window_minutes": 7, "formatting": False},
        ),
        403,
    )
    _error(
        admin.post(
            channel + "/reset",
            headers={"If-Match": _tag(current)},
            json={"keys": ["edit_window_minutes", "formatting"]},
        ),
        403,
    )
    _error(
        admin.post(
            channel + "/reset", headers={"If-Match": _tag(current)}, json={"keys": ["message_days"]}
        ),
        422,
    )
    _error(
        peer.patch(channel, headers={"If-Match": _tag(current)}, json={"edit_window_minutes": 7}),
        403,
    )
    _error(admin.patch(channel, json={"edit_window_minutes": 7}), 428)
    _error(admin.post(channel + "/reset", json={"keys": ["edit_window_minutes"]}), 428)
    assert stored(case) == before
    source_path = f"{ROOT}/conversations/{org.conversation}"
    source_before = _read(admin, source_path)
    reset = admin.post(
        channel + "/reset",
        headers={"If-Match": _tag(current)},
        json={"keys": ["edit_window_minutes"]},
    )
    saved = _ok(reset)
    assert saved["overrides"] == {"delete_window_minutes": 12}
    assert saved["effective"]["edit_window_minutes"] == 15
    assert saved["sources"]["edit_window_minutes"] == {"kind": "category", "id": str(org.category)}
    assert _tag(reset) != _tag(current)
    assert _tag(_read(admin, source_path)) != _tag(source_before)
    _unchanged_read(admin, channel, reset)
    _error(
        admin.patch(
            channel, headers={"If-Match": _tag(current)}, json={"delete_window_minutes": 20}
        ),
        412,
    )
    with case.world.session(org) as db:
        values = db.scalars(
            select(CommsSettings.values).where(
                CommsSettings.org_id == org.id, CommsSettings.conversation_id == org.conversation
            )
        ).one()
        assert values == {"delete_window_minutes": 12}
        logs = list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.org_id == org.id, AuditLog.request_path == channel + "/reset"
                )
            )
        )
        assert len(logs) == 1 and logs[0].performed_by == org.author
        assert logs[0].before["values"]["edit_window_minutes"] == 0
        assert "edit_window_minutes" not in logs[0].after["values"]
    _ok(
        admin.put(
            workspace + "/locks",
            headers={"If-Match": _tag(_read(admin, workspace))},
            json={"keys": []},
        )
    )
    assert _read(admin, channel).json()["effective"]["formatting"] is False
    for path in (channel, category, workspace):
        _ok(
            admin.patch(
                path,
                headers={"If-Match": _tag(_read(admin, path))},
                json={"quiet_hours_start": "22:00", "quiet_hours_end": "06:00"},
            )
        )
        before = _read(admin, path)
        _error(
            admin.post(
                path + "/reset",
                headers={"If-Match": _tag(before)},
                json={"keys": ["quiet_hours_start"]},
            ),
            422,
        )
        _unchanged_read(admin, path, before)
        _ok(
            admin.post(
                path + "/reset",
                headers={"If-Match": _tag(before)},
                json={"keys": ["quiet_hours_start", "quiet_hours_end"]},
            )
        )


def test_workspace_direct_policy_controls_new_and_existing_pair_admission_not_reads(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    workspace = ROOT + "/settings/workspace"
    _ok(
        admin.patch(
            workspace, headers={"If-Match": _tag(_read(admin, workspace))}, json={"dm_rule": "none"}
        )
    )
    _error(peer.post(ROOT + "/directs", json={"recipient_id": str(org.author)}), 403)
    changed = admin.patch(
        workspace, headers={"If-Match": _tag(_read(admin, workspace))}, json={"dm_rule": "everyone"}
    )
    assert _ok(changed)["dm_rule"] == "everyone"
    assert all(
        "dm_rule" not in changed.json()[key] for key in ("effective", "overrides", "sources")
    )
    direct = _ok(peer.post(ROOT + "/directs", json={"recipient_id": str(org.author)}), 201)
    _ok(
        admin.patch(
            workspace, headers={"If-Match": _tag(_read(admin, workspace))}, json={"dm_rule": "none"}
        )
    )
    _error(peer.post(ROOT + "/directs", json={"recipient_id": str(org.author)}), 403)
    assert _ok(peer.get(ROOT + "/conversations/" + direct["id"]))["id"] == direct["id"]


def test_settings_writes_compare_current_token_after_waits_and_foreign_scopes_remain_untouched(
    structure_routes,
):
    case, org, foreign = (
        structure_routes,
        structure_routes.world.first,
        structure_routes.world.second,
    )
    admin, neighbour = case.client(org.author, org.id), case.client(foreign.author, foreign.id)
    path = f"{ROOT}/settings/channel/{org.conversation}"
    old = _read(admin, path)
    gate = Barrier(2)
    a, b = (case.client(org.author, org.id, request_gate=gate) for _ in range(2))
    outcomes = _race(
        lambda: a.patch(
            path,
            headers={"If-Match": _tag(old)},
            json={"formatting": False, "edit_window_minutes": 12},
        ),
        lambda: b.patch(
            path,
            headers={"If-Match": _tag(old)},
            json={"formatting": True, "edit_window_minutes": 24},
        ),
    )
    assert sorted(row.status_code for row in outcomes) == [200, 412]
    winner = next(row for row in outcomes if row.status_code == 200)
    _unchanged_read(admin, path, winner)
    for kind, identity in (("category", foreign.category), ("channel", foreign.conversation)):
        path = f"{ROOT}/settings/{kind}/{identity}"
        current = _read(neighbour, path)
        before = stored(case, foreign)
        _error(admin.get(path), 404)
        _error(
            admin.patch(path, headers={"If-Match": _tag(current)}, json={"formatting": False}), 404
        )
        _error(
            admin.post(
                path + "/reset", headers={"If-Match": _tag(current)}, json={"keys": ["formatting"]}
            ),
            404,
        )
        assert stored(case, foreign) == before
    assert UUID(_read(admin, ROOT + "/settings/workspace").json()["org_id"]) == org.id
