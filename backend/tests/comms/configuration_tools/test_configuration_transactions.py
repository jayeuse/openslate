"""Locked multi-target failure behavior and concurrent version decisions on real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.exc import SQLAlchemyError

from app.core.database.session import AuditSession
from app.systems.comms.settings.models import CommsSettings
from app.systems.manage.audit.models import AuditLog
from tests.comms.configuration_tools.test_templates import ROOT, template_request
from tests.comms.routes.message_support import _ok

pytestmark = pytest.mark.integration


def test_bulk_apply_failure_rolls_back_every_target_audit_and_publication(
    tools_routes, monkeypatch
):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    source = _ok(api.post(ROOT, json=template_request()), 201)
    path = ROOT + "/" + source["id"]
    request = {
        "conversation_ids": [str(org.conversation), str(org.other_conversation)],
        "keys": ["allow_export"],
    }
    preview = api.post(path + "/application-preview", json=request)
    assert preview.status_code == 200
    with case.world.session(org) as db:
        before = db.scalar(select(func.count()).select_from(AuditLog))
    publications = []
    monkeypatch.setattr(api.app.state.comms_publisher, "submit", publications.extend)

    def unavailable(db, _context, _instances):
        if any(
            isinstance(row, CommsSettings) and row.conversation_id == org.other_conversation
            for row in list(db.new) + list(db.dirty)
        ):
            raise SQLAlchemyError("Owned last-target failure")

    event.listen(AuditSession, "before_flush", unavailable)
    try:
        assert (
            api.post(
                path + "/applications", json=request, headers={"If-Match": preview.headers["etag"]}
            ).status_code
            == 503
        )
    finally:
        event.remove(AuditSession, "before_flush", unavailable)
    for identity in request["conversation_ids"]:
        assert _ok(api.get("/api/comms/settings/channel/" + identity))["overrides"] == {}
    with case.world.session(org) as db:
        assert db.scalar(select(func.count()).select_from(AuditLog)) == before
    assert publications == []


@pytest.mark.parametrize("change", ["target", "setting-lock", "capability-lock"])
def test_preview_refuses_target_and_ancestor_lock_changes_without_partial_apply(
    tools_routes, change
):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    source = _ok(
        api.post(
            ROOT,
            json={
                **template_request(),
                "capabilities": {"group_grants": [], "everyone": {"react": False}},
            },
        ),
        201,
    )
    path = ROOT + "/" + source["id"]
    request = {
        "conversation_ids": [str(org.conversation), str(org.other_conversation)],
        "keys": ["allow_export"],
        "capability_keys": ["react"],
    }
    preview = api.post(path + "/application-preview", json=request)
    assert preview.status_code == 200
    workspace = "/api/comms/settings/workspace"
    if change == "target":
        target = f"/api/comms/settings/channel/{org.conversation}"
        current = api.get(target)
        assert (
            api.patch(
                target,
                json={"notification_sound": False},
                headers={"If-Match": current.headers["etag"]},
            ).status_code
            == 200
        )
    else:
        current = api.get(workspace)
        suffix, payload = (
            ("/locks", {"keys": ["allow_export"]})
            if change == "setting-lock"
            else (
                "/capability-locks",
                {"capabilities": ["react"]},
            )
        )
        assert (
            api.put(
                workspace + suffix, json=payload, headers={"If-Match": current.headers["etag"]}
            ).status_code
            == 200
        )
    assert (
        api.post(
            path + "/applications", json=request, headers={"If-Match": preview.headers["etag"]}
        ).status_code
        == 412
    )
    assert _ok(api.get(f"/api/comms/settings/channel/{org.other_conversation}"))["overrides"] == {}


def test_two_template_edits_share_a_real_version_lock(tools_routes):
    case, org = tools_routes, tools_routes.world.first
    api = case.client(org.author, org.id)
    created = api.post(ROOT, json=template_request())
    row = _ok(created, 201)
    gate = Barrier(2)
    clients = [case.client(org.author, org.id, request_gate=gate) for _ in range(2)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                client.put,
                ROOT + "/" + row["id"],
                json={**template_request(), "name": name},
                headers={"If-Match": created.headers["etag"]},
            )
            for client, name in zip(clients, ("First edit", "Second edit"), strict=True)
        ]
        responses = [future.result(timeout=30) for future in futures]
    assert sorted(response.status_code for response in responses) == [200, 412]
    winner = next(response.json() for response in responses if response.status_code == 200)
    assert _ok(api.get(ROOT + "/" + row["id"]))["name"] == winner["name"]
