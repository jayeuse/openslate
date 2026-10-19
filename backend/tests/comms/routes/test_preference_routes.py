"""C6 own-account+org preferences are last-write-wins, never conditional configuration."""

from threading import Barrier

import pytest

from tests.comms.routes.settings_support import stored
from tests.comms.routes.structure_support import (
    ROOT,
    _channel,
    _created,
    _error,
    _ok,
    _race,
    _read,
    _tag,
)

pytestmark = pytest.mark.integration


def test_preference_families_ignore_if_match_and_remain_private_to_account_and_org(
    structure_routes,
):
    case, org, foreign = (
        structure_routes,
        structure_routes.world.first,
        structure_routes.world.second,
    )
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    personal = ROOT + "/preferences"
    member = f"{ROOT}/conversations/{org.conversation}/preferences"
    category = f"{ROOT}/categories/{org.category}/preferences"
    before = stored(case)
    defaults = {path: _read(admin, path).json() for path in (personal, member, category)}
    assert stored(case) == before  # GET never creates or repairs state.
    own = defaults[personal]
    assert (own["density"], own["channel_width"], own["member_width"], own["thread_width"]) == (
        "comfortable",
        240,
        220,
        380,
    )
    assert own["shortcuts"] == {"search": "Alt+F", "new_message": "Alt+N"}
    assert defaults[member] == {
        "notify": "all",
        "mute": {"kind": "off"},
        "starred": False,
        "hidden": False,
        "manual_unread": False,
    }
    assert defaults[category] == {"collapsed": False, "mute": {"kind": "off"}}
    initial = {path: _tag(_read(admin, path)) for path in defaults}
    for headers, width in (
        ({}, 321),
        ({"If-Match": '"stale"'}, 322),
        ({"If-Match": "garbage"}, 323),
    ):
        body = {
            **own,
            "channel_width": width,
            "notifications": {
                "quiet_hours_start": "22:00",
                "quiet_hours_end": "06:00",
                "notification_preview": False,
            },
        }
        saved = _ok(admin.put(personal, headers=headers, json=body))
        assert saved == body and _read(admin, personal).json() == body
        member_body = {
            "starred": True,
            "mute": {"kind": "until", "until": "2100-01-01T06:00:00+08:00"},
        }
        saved = _ok(admin.patch(member, headers=headers, json=member_body))
        assert saved["starred"] is True and saved["mute"]["kind"] == "until"
        assert saved["notify"] == "all" and saved["manual_unread"] is False
        category_body = {"collapsed": True, "mute": {"kind": "indefinite"}}
        assert _ok(admin.put(category, headers=headers, json=category_body)) == category_body
    for path in defaults:
        assert _read(peer, path).json() == defaults[path]
        assert _tag(_read(admin, path)) != initial[path]
    assert stored(case)["audit_logs"] == before["audit_logs"]
    case.add_visited_guest()
    guest = case.client(org.author, foreign.id)
    assert _read(guest, personal).json() == own
    assert _ok(guest.put(personal, json={**own, "channel_width": 654}))["channel_width"] == 654
    assert _read(admin, personal).json()["channel_width"] == 323
    for path, method, payload in (
        (f"{ROOT}/conversations/{foreign.conversation}/preferences", "PATCH", {"hidden": True}),
        (f"{ROOT}/categories/{foreign.category}/preferences", "PUT", defaults[category]),
    ):
        before = stored(case, foreign)
        _error(admin.get(path), 404, "comms_not_found")
        _error(admin.request(method, path, json=payload), 404, "comms_not_found")
        assert stored(case, foreign) == before
        assert (
            guest.request(method, path, json=payload).status_code == 200
        )  # Personal guest writes.


def test_preferences_reject_context_injection_invalid_pairs_and_private_nonmember_admin(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    admin, peer = case.client(org.author, org.id), case.client(org.peer, org.id)
    personal = ROOT + "/preferences"
    member = f"{ROOT}/conversations/{org.conversation}/preferences"
    category = f"{ROOT}/categories/{org.category}/preferences"
    body = _read(admin, personal).json()
    before = stored(case)
    for patch in (
        {"user_id": str(org.peer)},
        {"org_id": str(org.id)},
        {"channel_width": True},
        {"channel_width": 0},
        {"notifications": {"quiet_hours_start": "22:00"}},
        {"notifications": {"formatting": False}},
        {"avatars": "false"},
    ):
        _error(admin.put(personal, json=body | patch), 422)
        assert stored(case) == before
    for payload in (
        {},
        {"hidden": None},
        {"starred": "true"},
        {"user_id": str(org.peer)},
        {"mute": {"kind": "until", "until": "2100-01-01T00:00:00"}},
        {"mute": {"kind": "off", "until": "2100-01-01T00:00:00Z"}},
    ):
        _error(admin.patch(member, json=payload), 422)
        assert stored(case) == before
    _error(admin.put(category, json={"collapsed": True}), 422)
    _error(admin.put(category, json={"collapsed": "true", "mute": {"kind": "off"}}), 422)
    _, path = _created(
        admin,
        ROOT + "/conversations",
        _channel(
            "Private preferences",
            scope="members",
            member_ids=[str(org.peer)],
        ),
    )
    assert (
        admin.delete(
            path + f"/members/{org.author}", headers={"If-Match": _tag(_read(admin, path))}
        ).status_code
        == 204
    )
    before = stored(case)
    _error(admin.get(path + "/preferences"), 404, "comms_not_found")
    _error(admin.patch(path + "/preferences", json={"starred": True}), 404, "comms_not_found")
    assert stored(case) == before
    assert _ok(peer.patch(path + "/preferences", json={"manual_unread": True}))["manual_unread"]


def test_first_preference_patches_merge_at_commit_and_mark_read_clears_manual_reminder(
    structure_routes,
):
    case, org = structure_routes, structure_routes.world.first
    gate = Barrier(2)
    a, b = (case.client(org.author, org.id, request_gate=gate) for _ in range(2))
    path = f"{ROOT}/conversations/{org.conversation}/preferences"
    results = _race(
        lambda: a.patch(path, json={"starred": True}),
        lambda: b.patch(path, json={"manual_unread": True}),
    )
    assert [r.status_code for r in results] == [200, 200]
    admin = case.client(org.author, org.id)
    current = _read(admin, path).json()
    assert current["starred"] is True and current["manual_unread"] is True
    _ok(admin.put(f"{ROOT}/conversations/{org.conversation}/read", json={"last_read_seq": 0}))
    current = _read(admin, path).json()
    assert current["starred"] is True and current["manual_unread"] is False
