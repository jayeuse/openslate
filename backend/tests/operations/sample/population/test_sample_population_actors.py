"""Population retains active members required for record and content work."""

import json
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.packs import get_pack
from operations.sample.population import workflow
from operations.sample.population.people import (
    SampleActorCredential,
    SamplePeopleResult,
    SamplePerson,
)
from operations.sample.population.run import SamplePopulationError
from operations.sample.scenario import build_dataset

MANAGER = "internal_finance_lead"


class ContentReady(RuntimeError):
    """Stop the isolated workflow before content or activity writes."""


def _id(key):
    return str(uuid5(NAMESPACE_URL, "population-actors:" + key))


def _isolated_workflow(tmp_path, monkeypatch, missing=None):
    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack("school")
    )
    people = {person.key: person for person in dataset.organization.actors.people}
    active = {
        key
        for key, person in people.items()
        if person.role == "member" and person.status == "active"
    }
    record_keys = {record.creator_key for record in dataset.records} | {
        record.assignee_key for record in dataset.records
    }
    assert MANAGER in active - record_keys
    absent = (
        next(record.creator_key for record in dataset.records)
        if missing == "writer"
        else MANAGER
        if missing == "manager"
        else None
    )
    credentials = {
        key: SampleActorCredential(_id(key), people[key].email, "offline-only-password")
        for key in active
        if key != absent
    }
    users = {
        key: SamplePerson(_id(key), person.email, person.username, person.role, person.status)
        for key, person in people.items()
    }
    result = SamplePeopleResult(users=users, actors=credentials, groups={})
    state = {
        "logins": [],
        "clients": {},
        "content_reached": False,
        "workspace": {
            "revision": 1,
            "currency": "PHP",
            "mark": "RS",
            "week_start": "monday",
            "business_hours": "09:00–18:00",
        },
    }
    emails = {person.email: _id(key) for key, person in people.items()}
    admin_email = "administrator@northside.example"
    emails[admin_email] = _id("admin")

    def offline_client(*args, **kwargs):
        authenticated = {}

        def handler(request):
            if request.url.path == "/api/auth/login":
                email = json.loads(request.content)["email"]
                authenticated["email"] = email
                state["logins"].append(email)
                return httpx.Response(
                    200,
                    json={"authenticated": True},
                    headers=[
                        ("set-cookie", "openslate_access=opaque; Path=/"),
                        ("set-cookie", "openslate_csrf=csrf; Path=/"),
                    ],
                )
            if request.url.path == "/api/auth/me":
                email = authenticated["email"]
                return httpx.Response(
                    200, json={"id": emails[email], "email": email, "status": "active"}
                )
            if request.url.path == "/api/workspace" and request.method == "PATCH":
                from app.systems.manage.workspace.schemas import WorkspaceUpdate

                body = json.loads(request.content)
                WorkspaceUpdate.model_validate(body)
                assert body["revision"] == state["workspace"]["revision"]
                state["workspace"].update({**body, "revision": body["revision"] + 1})
                return httpx.Response(200, json=state["workspace"])
            if request.url.path == "/api/workspace" and request.method == "GET":
                return httpx.Response(200, json=state["workspace"])
            pytest.fail(f"Unexpected isolated request {request.method} {request.url.path}")

        return SampleClient(*args, **kwargs, transport=httpx.MockTransport(handler))

    def prepare_content(_admin, *, clients, **_kwargs):
        state["content_reached"] = True
        state["clients"] = dict(clients)
        raise ContentReady

    fields = {
        f"{module}:{key}": value
        for module, values in dataset.field_ids.items()
        for key, value in values.items()
    }
    monkeypatch.setattr(workflow, "SampleClient", offline_client)
    monkeypatch.setattr(
        workflow,
        "assert_pristine_baseline",
        lambda *_args, **_kwargs: {"workspace": {"revision": 1}, "boards": []},
    )
    monkeypatch.setattr(workflow, "assert_empty_content", lambda *_args: None)
    monkeypatch.setattr(workflow, "_publish_sandbox", lambda *_args: None)
    monkeypatch.setattr(
        workflow,
        "_catalogue",
        lambda *_args: (
            {},
            {key: {"id": value} for key, value in dataset.module_ids.items()},
            {},
            {},
            dataset.department_ids,
            dataset.module_ids,
            fields,
        ),
    )
    monkeypatch.setattr(workflow, "populate_people", lambda *_args, **_kwargs: result)
    monkeypatch.setattr(workflow.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(workflow, "prepare_content", prepare_content)
    monkeypatch.setattr(
        workflow, "run_activity", lambda *_args, **_kwargs: pytest.fail("activity must not start")
    )
    manifest = {}

    def invoke():
        return workflow.run_population(
            api_url="https://api.example.test",
            origin="https://workspace.example.test",
            mailpit_url="https://mail.example.test",
            admin_email=admin_email,
            admin_password="offline-only-password",
            expected_admin_id=_id("admin"),
            run_directory=tmp_path,
            run_id="a" * 32,
            dataset=dataset,
            manifest=manifest,
        )

    return invoke, state, manifest, active, people


def test_population_retains_and_logs_in_content_only_active_members(tmp_path, monkeypatch):
    invoke, state, manifest, active, people = _isolated_workflow(tmp_path, monkeypatch)

    with pytest.raises(ContentReady):
        invoke()

    assert state["content_reached"] is True
    assert active <= state["clients"].keys()
    assert people[MANAGER].email in state["logins"]
    assert manifest["actor_ids"][MANAGER] == _id(MANAGER)
    assert {
        key: state["workspace"][key] for key in ("currency", "mark", "week_start", "business_hours")
    } == {"currency": "GBP", "mark": "WDS", "week_start": "monday", "business_hours": "09:00–18:00"}


@pytest.mark.parametrize("missing", ("writer", "manager"))
def test_population_stops_before_activity_when_a_required_member_is_missing(
    tmp_path, monkeypatch, missing
):
    invoke, state, _manifest, _active, _people = _isolated_workflow(tmp_path, monkeypatch, missing)

    with pytest.raises(SamplePopulationError, match="identities are incomplete"):
        invoke()

    assert state["content_reached"] is False
    assert state["clients"] == {}
