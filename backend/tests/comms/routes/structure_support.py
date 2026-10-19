"""Shared assertions and current S16 readback for structure-only route tests."""

from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

from sqlalchemy import select

from app.systems.access.users.models import User
from app.systems.comms.capabilities import capability_check, channel_creation_check
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettings
from app.systems.comms.settings.resolution import resolve_settings

ROOT = "/api/comms"


def _ok(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def _error(response, status, code=None):
    assert response.status_code == status, response.text
    if code is not None:
        detail = response.json()["detail"]
        assert set(detail) == {"code", "message"}
        assert detail["code"] == code and isinstance(detail["message"], str)


def _tag(response):
    value = response.headers["etag"]
    assert value.startswith('"') and value.endswith('"') and len(value) > 2
    return value


def _read(api, path):
    response = api.get(path)
    _ok(response)
    _tag(response)
    assert "no-store" in response.headers["cache-control"]
    return response


def _channel(name, category=None, scope="organization", **fields):
    return {
        "name": name,
        "topic": "",
        "position": 0,
        "category_id": str(category) if category else None,
        "scope": scope,
        **fields,
    }


def _created(api, collection, payload):
    response = api.post(collection, json=payload)
    body = _ok(response, 201)
    UUID(body["id"])
    assert response.headers["location"] == f"{ROOT}/conversations/{body['id']}"
    _tag(response)
    return body, response.headers["location"]


def _unchanged_read(api, path, before):
    current = _read(api, path)
    assert current.json() == before.json()
    assert _tag(current) == _tag(before)


def _race(left, right):
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(left), pool.submit(right)]
        return [future.result(timeout=30) for future in futures]


def _rights(case, actor, conversation):
    with case.world.session(case.world.first) as db:
        return capability_check(db, db.get(User, actor), UUID(str(conversation)))


def _creation(case, actor, category=None):
    with case.world.session(case.world.first) as db:
        scope = (
            {"kind": "category", "id": UUID(str(category))} if category else {"kind": "workspace"}
        )
        return channel_creation_check(db, db.get(User, actor), scope)["decision"]["allowed"]


def _configuration(case, conversation):
    with case.world.session(case.world.first) as db:
        scope = {"kind": "channel", "id": UUID(str(conversation))}
        settings = resolve_settings(db, scope)
        grants = [
            (r.capability, r.subject, r.group_id, r.granted)
            for r in db.scalars(
                select(CommsCapabilityGrant)
                .where(
                    CommsCapabilityGrant.conversation_id == scope["id"],
                    CommsCapabilityGrant.is_deleted.is_(False),
                )
                .order_by(CommsCapabilityGrant.capability)
            )
        ]
        return settings, grants


def _snapshot(case):
    state = case.structure_state()
    with case.world.session(case.world.first) as db:
        for model in (CommsSettings, CommsCapabilityGrant):
            state[model.__tablename__] = db.execute(
                select(model.__table__)
                .where(
                    model.org_id == case.world.first.id,
                )
                .order_by(model.id)
            ).all()
    return state
