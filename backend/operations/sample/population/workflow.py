"""Ordered, authenticated UI-API population of one organization sample run."""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.episodes import plan_sessions
from operations.sample.phases.population import run_population_phases
from operations.sample.population.activity import build_record_payload as build_record_payload
from operations.sample.population.activity import relationship_write as relationship_write
from operations.sample.population.activity import run_activity
from operations.sample.population.administrator import (
    create_run_roster,
    invite_pack_administrator,
    partner_client_factory,
)
from operations.sample.population.content import (
    assert_empty_content,
    finish_content,
    prepare_content,
)
from operations.sample.population.people import populate_people
from operations.sample.population.run import (
    SamplePopulationError,
    _api,
    _catalogue,
    _login,
    _write_manifest,
)
from operations.sample.population.sandbox_publication import _publish_sandbox
from operations.sample.population.triggers import (
    exercise_record_triggers,
    validate_record_trigger_candidates,
)
from operations.sample.verification.core import assert_pristine_baseline
from operations.sample.verification.rejections import RejectionContext, run_rejection

_CONTENT_KEYS = (
    "boards",
    "posts",
    "events",
    "reminders",
    "files",
    "record_links",
    "project_group_grants",
    "post_publications",
    "publication_revisions",
    "kanban_stages",
    "kanban_labels",
    "kanban_cards",
    "kanban_checklist_items",
    "calendar_sources",
    "views",
    "dashboards",
    "dashboard_widgets",
    "reports",
    "report_runs",
    "schedules",
    "disabled_schedules",
)


def run_population(
    *,
    api_url: str,
    origin: str,
    mailpit_url: str,
    operator_email: str,
    operator_password: str,
    expected_operator_id: str,
    run_directory: Path,
    run_id: str,
    dataset: SampleDataset,
    manifest: dict[str, Any],
    mfa_observer: Callable[..., object] | None = None,
    host_control: Callable[..., object] | None = None,
    administrator_password: str | None = None,
    organization_id: str | None = None,
    partner_organization_id: str | None = None,
) -> dict[str, int]:
    """Run the sample as the pack administrator the operator invites; persist safe evidence."""
    journal = run_directory / "requests.jsonl"
    clients: dict[str, SampleClient] = {}
    try:
        operator = SampleClient(api_url, origin, journal, organization_id)
        clients["operator"] = operator
        _login(operator, operator_email, operator_password, expected_id=expected_operator_id)
        manifest["stage"] = "baseline"
        _write_manifest(run_directory, manifest)
        baseline = assert_pristine_baseline(operator, operator_id=expected_operator_id)
        assert_empty_content(operator, baseline["boards"])
        validate_record_trigger_candidates(dataset)

        manifest["stage"] = "administrator"
        _write_manifest(run_directory, manifest)
        roster = create_run_roster(
            run_directory / "credentials.json", dataset.organization, administrator_password
        )
        administrator = invite_pack_administrator(
            operator, roster, api_url=api_url, origin=origin, mailpit_url=mailpit_url,
            organization_id=organization_id, operator_id=expected_operator_id,
        )  # fmt: skip
        admin_password, expected_admin_id = administrator.password, administrator.user_id
        manifest["admin_id"] = expected_admin_id
        _write_manifest(run_directory, manifest)
        admin = clients["admin"] = SampleClient(api_url, origin, journal, organization_id)
        _login(admin, administrator.email, admin_password, expected_id=expected_admin_id)

        from datetime import UTC, datetime

        manifest["started_at"] = datetime.now(UTC).isoformat()
        manifest["stage"] = "workspace"
        _write_manifest(run_directory, manifest)
        workspace = baseline["workspace"]
        from operations.sample.controls.manage import organization_settings

        settings = organization_settings(dataset)
        updated = _api(
            admin,
            "PATCH",
            "/api/workspace",
            body={
                "revision": workspace["revision"],
                **settings,
            },
        )
        persisted = _api(admin, "GET", "/api/workspace")
        if (
            any(
                updated.get(key) != value or persisted.get(key) != value
                for key, value in settings.items()
            )
            or type(updated.get("revision")) is not int
            or updated["revision"] != workspace["revision"] + 1
            or persisted.get("revision") != updated["revision"]
        ):
            raise SamplePopulationError("Workspace settings readback did not match the sample")

        manifest["stage"] = "sandbox"
        _write_manifest(run_directory, manifest)
        prune_fixture = _publish_sandbox(admin, dataset, admin_password, run_id, expected_admin_id)
        (
            departments,
            modules,
            fields,
            relationships,
            department_ids,
            module_ids,
            field_ids,
        ) = _catalogue(admin, dataset)
        manifest["mappings"] = _journal_mappings(journal)
        _write_manifest(run_directory, manifest)

        manifest["stage"] = "people"
        _write_manifest(run_directory, manifest)
        people_result = populate_people(
            admin,
            api_url,
            department_ids,
            module_ids,
            mailpit_url,
            origin,
            roster,
            organization=dataset.organization,
            organization_id=organization_id,
        )
        people = {
            key: {
                "user_id": person.user_id,
                "role": person.role,
                "status": person.status,
            }
            for key, person in people_result.users.items()
        }
        actor_ids = {key: value.user_id for key, value in people_result.actors.items()}
        required_actors = {
            person.key
            for person in dataset.organization.actors.people
            if person.role == "member" and person.status == "active"
        }
        required_actors |= {record.creator_key for record in dataset.records} | {
            record.assignee_key for record in dataset.records
        }
        if not required_actors <= set(actor_ids):
            raise SamplePopulationError("The acting team member identities are incomplete")
        manifest["people"] = people
        manifest["actor_ids"] = actor_ids
        manifest["mappings"] = _journal_mappings(journal)
        _write_manifest(run_directory, manifest)

        for actor_key, credential in people_result.actors.items():
            client = SampleClient(api_url, origin, journal, organization_id)
            clients[actor_key] = client
            _login(
                client,
                credential.email,
                credential.password,
                expected_id=credential.user_id,
            )
            # Sign in one person at a time; sign-in and refresh share one Auth limit.
            time.sleep(0.1)

        # People work in interleaved sessions: each creates records and links them.
        manifest["stage"] = "activity"
        _write_manifest(run_directory, manifest)
        document_fields = _document_field_map(dataset, field_ids)
        by_logical = {record.logical_id: record for record in dataset.records}

        def new_client() -> SampleClient:
            extra = SampleClient(api_url, origin, journal, organization_id)
            clients[f"rejection-session-{len(clients)}"] = extra
            return extra

        def template_payload(logical_id: str) -> dict[str, Any]:
            module_key = logical_id.split(":")[0]
            return build_record_payload(
                by_logical[logical_id],
                module_id=str(modules[module_key]["id"]),
                api_field_ids=document_fields[module_key],
                actor_ids=actor_ids,
            )

        def save_rejections(results: list[dict[str, Any]]) -> None:
            manifest["expected_failures"] = results
            _write_manifest(run_directory, manifest)

        rejections = RejectionContext(
            dataset=dataset,
            admin=admin,
            clients=clients,
            new_client=new_client,
            roster_path=run_directory / "credentials.json",
            mappings=lambda: _journal_mappings(journal),
            build_payload=template_payload,
            field_map=lambda module_key: document_fields[module_key],
            results=[],
            save=save_rejections,
        )
        board_queue, board_counts = prepare_content(
            admin,
            clients=clients,
            departments=departments,
            modules=modules,
            fields=fields,
            groups=people_result.groups,
            anchor_date=dataset.anchor_date,
            organization=dataset.organization,
            profile=dataset.profile,
        )
        sessions = plan_sessions(dataset)
        board_queue.pace(len(sessions))
        activity = run_activity(
            dataset,
            sessions,
            modules=modules,
            field_ids=document_fields,
            relationship_fields=relationships,
            actor_ids=actor_ids,
            clients=clients,
            rejections=rejections,
            content=board_queue,
        )
        records, edge_count = activity.records, activity.edge_count
        manifest["observed"] = {
            "records_created": len(records),
            "record_edges_created": edge_count,
            "history_updates": activity.history_updates,
            "history_steps_already_done": len(activity.history_skipped),
        }
        manifest["history_skipped"] = activity.history_skipped
        manifest["mappings"] = _journal_mappings(journal)
        _write_manifest(run_directory, manifest)

        manifest["stage"] = "record_triggers"
        _write_manifest(run_directory, manifest)
        trigger_evidence, mutation_evidence = exercise_record_triggers(
            admin, dataset, records, modules, field_ids, actor_ids, clients
        )
        manifest["trigger_evidence"] = trigger_evidence
        manifest["mutation_evidence"] = mutation_evidence
        manifest["mappings"] = _journal_mappings(journal)
        _write_manifest(run_directory, manifest)

        manifest["stage"] = "content"
        _write_manifest(run_directory, manifest)
        content_counts = finish_content(
            admin,
            board_queue,
            clients=clients,
            records=records,
            board_counts=board_counts,
            departments=departments,
            modules=modules,
            fields=fields,
            anchor_date=dataset.anchor_date,
            seed=dataset.seed,
            organization=dataset.organization,
        )
        counts = {key: int(content_counts.get(key, -1)) for key in _CONTENT_KEYS}
        if any(value < 0 for value in counts.values()):
            raise SamplePopulationError("Content workflow omitted expected result counts")
        manifest["content_counts"] = counts
        for case in dataset.organization.rejections.closing_cases:
            run_rejection(rejections, case)
        manifest["expected_failures"] = rejections.results
        manifest["mappings"] = _journal_mappings(journal)
        _write_manifest(run_directory, manifest)
        manifest["observed"].update(
            {
                "records_created": len(records),
                "record_edges_created": edge_count,
                "planned_rejections": len(rejections.results),
                **counts,
            }
        )
        private_values: dict[str, Any] = {
            "credentials": people_result.actors,
            "new_client": new_client,
            "mailpit_url": mailpit_url,
            "origin": origin,
            "operator_password": operator_password,
        }
        if prune_fixture is not None:
            private_values["sandbox_prune_fixture"] = prune_fixture
        if partner_organization_id is not None:  # The operator administers the partner.
            private_values["partner_admin"] = private_values["partner_actor"] = (
                partner_client_factory(
                    api_url=api_url, origin=origin, journal=journal, clients=clients,
                    partner_organization_id=partner_organization_id, actors=people_result.actors,
                    operator=(operator_email, operator_password, expected_operator_id),
                )
            )  # fmt: skip
        if mfa_observer is not None:
            private_values["mfa_observer"] = mfa_observer
        if host_control is not None:
            private_values["host_control"] = host_control
        phase_counts = run_population_phases(
            dataset,
            manifest,
            clients=clients,
            user_ids={
                "admin": expected_admin_id,
                "operator": expected_operator_id,
                **{key: row["user_id"] for key, row in people.items()},
            },
            group_ids=people_result.groups,
            admin_password=admin_password,
            save=lambda: _write_manifest(run_directory, manifest),
            mappings=lambda: _journal_mappings(journal),
            private_values=private_values,
        )
        manifest["observed"].update(phase_counts)
        return cast(dict[str, int], manifest["observed"])
    finally:
        for client in clients.values():
            client.close()


def _document_field_map(
    dataset: SampleDataset, api_field_ids: Mapping[str, str]
) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for module_key, fields in dataset.field_ids.items():
        result[module_key] = {}
        for field_key, document_id in fields.items():
            api_id = api_field_ids.get(f"{module_key}:{field_key}")
            if not api_id:
                raise SamplePopulationError("Published record field mapping is incomplete")
            result[module_key][document_id] = api_id
    return result


def _journal_mappings(path: Path) -> dict[str, dict[str, str]]:
    import json
    import os
    import stat

    mappings: dict[str, dict[str, str]] = {}
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            raise ValueError
        if os.name != "nt" and (
            metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077
        ):
            raise ValueError
        with path.open("r", encoding="utf-8") as stream:
            for line in stream:
                event = json.loads(line)
                if not isinstance(event, dict) or event.get("event") != "id_mapping":
                    continue
                raw_kind, raw_logical, raw_server = (
                    event.get("kind"),
                    event.get("logical_id"),
                    event.get("server_id"),
                )
                if not all(isinstance(value, str) for value in (raw_kind, raw_logical, raw_server)):
                    raise ValueError
                kind = cast(str, raw_kind)
                logical = cast(str, raw_logical)
                server = cast(str, raw_server)
                try:
                    normalized = str(UUID(server))
                except ValueError:
                    raise ValueError from None
                bucket = mappings.setdefault(kind, {})
                if logical in bucket and bucket[logical] != normalized:
                    raise ValueError
                bucket[logical] = normalized
    except (OSError, UnicodeError, ValueError):
        raise SamplePopulationError("The private API journal is invalid or ambiguous") from None
    for singular, plural in (
        ("user", "users"),
        ("group", "groups"),
        ("record", "records"),
    ):
        if singular in mappings:
            mappings[plural] = dict(mappings[singular])
    return mappings
