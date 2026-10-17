"""Population retains active members required for record and content work."""

import json
from datetime import date
from types import SimpleNamespace
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
from tests.operations.sample.sample_datasets import sample_dataset

MANAGER = "internal_finance_lead"


class ContentReady(RuntimeError):
    """Stop the isolated workflow before content or activity writes."""


def _id(key):
    return str(uuid5(NAMESPACE_URL, "population-actors:" + key))


def _isolated_workflow(tmp_path, monkeypatch, missing=None, *, complete=False):
    dataset = sample_dataset(pack="school")
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
        "dataset": dataset,
        "credentials": credentials,
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
        if complete:
            return SimpleNamespace(pace=lambda _count: None), {}
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
    if complete:
        from operations.sample.phases.expectations import phase_plan_summary

        manifest.update(phase_plan_summary(dataset))
        monkeypatch.setattr(workflow, "plan_sessions", lambda _dataset: ())
        monkeypatch.setattr(
            workflow,
            "run_activity",
            lambda *_args, **_kwargs: SimpleNamespace(
                records={}, edge_count=0, history_updates=0, history_skipped=[]
            ),
        )
        monkeypatch.setattr(workflow, "exercise_record_triggers", lambda *_args: ([], []))
        monkeypatch.setattr(
            workflow,
            "finish_content",
            lambda *_args, **_kwargs: dict.fromkeys(workflow._CONTENT_KEYS, 0),
        )
        monkeypatch.setattr(workflow, "run_rejection", lambda *_args: None)

    def invoke(**callbacks):
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
            **callbacks,
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


def _callback_population(tmp_path, monkeypatch, *, entry, supplied=True, fail_observer=False):
    from operations import seed_sample_data as command
    from operations.sample.controls.mfa_observation import configure_mfa_observer
    from operations.sample.phases import population as phases
    from operations.sample.population import run as population
    from operations.sample.verification import run as verifier
    from operations.sample.verification.run import SampleVerificationReport

    invoke, state, manifest, _active, _people = _isolated_workflow(
        tmp_path, monkeypatch, complete=True
    )
    calls, contexts, fresh_clients = [], [], []

    def observe(stage, payload):
        if fail_observer:
            raise RuntimeError("private-callback-failure-marker")
        calls.append(("mfa", stage, payload["owner_id"]))

    def host(*_args, **_kwargs):
        calls.append(("host", "private-callback-owned-state"))

    callbacks = {"mfa_observer": observe, "host_control": host} if supplied else {}

    def execute(action, _dataset, context, *, on_substep):
        if action.values.get("operation") == "real_mfa_reset":
            contexts.append(context)
            private = context.private_values
            assert private["credentials"] is state["credentials"]
            assert private["origin"] == "https://workspace.example.test"
            assert private["mailpit_url"] == "https://mail.example.test"
            fresh = private["new_client"]()
            fresh_clients.append(fresh)
            assert fresh.request("GET", "/api/workspace").json() == state["workspace"]
            if supplied:
                assert (
                    private.get("mfa_observer") is observe and private.get("host_control") is host
                )
                configure_mfa_observer(private, action, context.user_ids)("before_reset", (), ())
                private["host_control"]()
            else:
                assert "mfa_observer" not in private and "host_control" not in private
                configure_mfa_observer(private, action, context.user_ids)("before_reset", (), ())
        return {"action_key": action.key, "request_evidence": []}

    monkeypatch.setattr(phases, "execute_phase_action", execute)
    monkeypatch.setattr(population, "build_dataset", lambda *_args, **_kwargs: state["dataset"])
    monkeypatch.setattr(
        verifier,
        "verify_sample_data",
        lambda **kwargs: SampleVerificationReport("complete", kwargs["run_directory"], {}, ()),
    )
    if entry == "workflow":
        invoke(**callbacks)
        directory, status = tmp_path, 0
    elif entry == "population":
        report = population.populate_sample_data(
            api_url="https://api.example.test",
            origin="https://workspace.example.test",
            mailpit_url="https://mail.example.test",
            admin_email="administrator@northside.example",
            expected_admin_id=_id("admin"),
            admin_password="offline-only-password",
            run_root=tmp_path,
            profile="small",
            seed=42,
            anchor_date=date(2026, 9, 30),
            organization=get_pack("school"),
            **callbacks,
        )
        directory, status = report.run_directory, 0 if report.status == "complete" else 1
    else:
        monkeypatch.setattr(command, "build_dataset", lambda *_args, **_kwargs: state["dataset"])
        monkeypatch.setattr(
            command,
            "_local_preflight",
            lambda *_args: (
                {
                    "admin_id": _id("admin"),
                    "organization_id": _id("organization"),
                    "partner_organization_id": _id("partner"),
                    "storage_objects": 0,
                    "provider_accounts": 0,
                },
                "https://api.example.test",
                "https://mail.example.test",
            ),
        )
        monkeypatch.setattr(
            command,
            "_environment_values",
            lambda: (
                {},
                None,
                "administrator@northside.example",
                "https://api.example.test",
                "https://workspace.example.test",
                2.0,
            ),
        )
        monkeypatch.setattr(
            population, "read_admin_password", lambda *_args: "offline-only-password"
        )
        monkeypatch.setattr(command, "_print_plan", lambda *_args: None)
        status = command.main(
            [
                "populate",
                "--run-root",
                str(tmp_path),
                "--organization",
                "school",
                "--seed",
                "42",
                "--anchor-date",
                "2026-09-30",
                "--admin-password-file",
                str(tmp_path / "unused-fixture-password-file"),
            ],
            **callbacks,
        )
        manifests = list(tmp_path.glob("*/manifest.json"))
        assert len(manifests) == 1
        directory = manifests[0].parent
    published = (directory / "manifest.json").read_text()
    journal = (directory / "requests.jsonl").read_text()
    assert all(client._client.is_closed for client in fresh_clients)
    for private_value in (
        "mfa_observer",
        "host_control",
        "offline-only-password",
        "private-callback-owned-state",
        "private-callback-failure-marker",
    ):
        assert private_value not in published and private_value not in journal
    return status, calls, contexts, json.loads(published)


@pytest.mark.parametrize("entry", ("main", "population", "workflow"))
def test_private_acceptance_callbacks_reach_real_phase_context_without_publication(
    tmp_path, monkeypatch, entry
):
    status, calls, contexts, manifest = _callback_population(tmp_path, monkeypatch, entry=entry)
    assert status == 0
    assert len(contexts) == 1
    assert calls == [
        ("mfa", "before_reset", _id("admin")),
        ("host", "private-callback-owned-state"),
    ]
    assert manifest["control_results"]


def test_omitted_acceptance_callbacks_stay_absent_in_phase_context(tmp_path, monkeypatch):
    status, calls, contexts, manifest = _callback_population(
        tmp_path, monkeypatch, entry="main", supplied=False
    )
    assert status == 0 and calls == [] and len(contexts) == 1
    assert "provider_sessions_verified" not in json.dumps(manifest)


def test_callback_failure_is_published_as_safe_incomplete_run(tmp_path, monkeypatch, capsys):
    status, calls, contexts, manifest = _callback_population(
        tmp_path, monkeypatch, entry="main", fail_observer=True
    )
    assert status == 1 and calls == [] and len(contexts) == 1
    assert manifest["status"] == "incomplete"
    assert manifest["failure"]["error_type"] == "SamplePhaseActionError"
    assert manifest["failed_step"] == "control:account-mfa-reset"
    output = capsys.readouterr()
    assert "private-callback-failure-marker" not in output.out + output.err
