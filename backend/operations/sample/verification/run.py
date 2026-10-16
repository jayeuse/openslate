"""Read back a private sample run through authenticated application APIs."""

from __future__ import annotations

import json
import os
import re
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID

from operations.sample.client import SampleClient
from operations.sample.controls.verification import configuration_mappings, verify_controls
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack, get_pack
from operations.sample.packs.types import SampleProfile
from operations.sample.phases.expectations import final_people_pack, read_phase_plan
from operations.sample.phases.verification import verify_phases
from operations.sample.population.content import verify_content
from operations.sample.population.people import _people
from operations.sample.scenario import build_dataset
from operations.sample.verification.configuration import verify_configuration
from operations.sample.verification.core import (
    SampleVerificationError,
    list_all_rows,
    verify_records_and_relationships,
)
from operations.sample.verification.history import verify_history
from operations.sample.verification.isolation import roster_logins, verify_isolation
from operations.sample.verification.rejections import verify_rejections
from operations.sample.verification.route_coverage import verify_route_coverage


@dataclass(frozen=True)
class SampleVerificationReport:
    status: str
    run_directory: Path
    observed: Mapping[str, int]
    issues: tuple[str, ...]


def read_run_manifest(directory: Path, expected_admin_id: str) -> dict[str, Any]:
    """Reject public, redirected, mismatched or malformed run evidence."""
    try:
        metadata = directory.lstat()
        if (
            not directory.is_absolute()
            or directory.is_symlink()
            or not stat.S_ISDIR(metadata.st_mode)
            or (
                os.name != "nt"
                and (metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077)
            )
        ):
            raise ValueError
        descriptor = os.open(
            directory / "manifest.json", os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        )
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or (
                os.name != "nt"
                and (metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077)
            ):
                raise ValueError
            value = json.load(stream)
    except (OSError, ValueError, UnicodeError):
        raise SampleVerificationError("Run evidence must be valid private files") from None
    if (
        not isinstance(value, dict)
        or type(value.get("schema_version")) is not int
        or value["schema_version"] not in {1, 2}
    ):
        raise SampleVerificationError("Run manifest schema is unsupported")
    if value.get("admin_id") != expected_admin_id:
        raise SampleVerificationError("Run belongs to another administrator")
    if (
        value.get("run_id") != directory.name
        or not re.fullmatch(r"[a-f0-9]{32}", directory.name)
        or value.get("status") not in {"running", "incomplete", "populated", "complete"}
        or value.get("profile") not in {"small", "standard", "large"}
        or type(value.get("seed")) is not int
        or any(
            not isinstance(value.get(key), dict)
            for key in ("mappings", "actor_ids", "content_counts", "people")
        )
    ):
        raise SampleVerificationError("Run manifest is incomplete or invalid")
    organization_id = value.get("organization_id")
    try:
        # Runs before one organization per pack have none; the session's one applies.
        if organization_id is not None and str(UUID(organization_id)) != organization_id:
            raise ValueError
    except (TypeError, ValueError, AttributeError):
        raise SampleVerificationError("Run organization is invalid") from None
    _manifest_plan(value)
    read_phase_plan(value)
    return value


def _manifest_plan(
    manifest: Mapping[str, Any],
) -> tuple[OrganizationPack, dict[str, int]]:
    """Use recorded volumes; schema 1 predates pack selection and the new sizes."""
    profile = cast(SampleProfile, manifest["profile"])
    if manifest["schema_version"] == 1:
        pack = default_pack()
        legacy = pack.catalog.legacy_counts_by_profile
        if legacy is None:
            raise SampleVerificationError("Legacy run counts are unavailable")
        return pack, dict(legacy[profile])
    key = manifest.get("organization")
    if (
        not isinstance(key, str)
        or not key
        or any(
            not isinstance(manifest.get(field), str) or not manifest[field].strip()
            for field in ("span", "sampling_scope")
        )
    ):
        raise SampleVerificationError("Run organization metadata is invalid")
    try:
        pack = get_pack(key)
    except ValueError:
        raise SampleVerificationError("Run organization metadata is invalid") from None
    counts = manifest.get("module_counts")
    if (
        not isinstance(counts, dict)
        or set(counts) != {module.key for module in pack.catalog.modules}
        or any(type(count) is not int or count < 1 for count in counts.values())
    ):
        raise SampleVerificationError("Run module counts are incomplete or invalid")
    return pack, dict(counts)


def _people_issues(
    client: SampleClient,
    manifest: Mapping[str, Any],
    admin_id: str,
    *,
    organization: OrganizationPack | None = None,
) -> tuple[dict[str, int], list[str]]:
    actual = {str(row.get("id")): row for row in list_all_rows(client, "/api/users")}
    expected = manifest["people"]
    issues: list[str] = []
    expected_ids = {str(person.get("user_id")) for person in expected.values()}
    specs = _people(final_people_pack(organization or default_pack(), read_phase_plan(manifest)))
    if len(expected) != len(specs) or len(expected_ids) != len(specs):
        issues.append("identity manifest does not cover the pack's unique people")
    if set(actual) != expected_ids | {admin_id}:
        issues.append("identity roster differs from the recorded run")
    if set(expected) != {person.key for person in specs}:
        issues.append("identity manifest differs from the authored person catalogue")
    for spec in specs:
        person = expected.get(spec.key, {})
        row = actual.get(str(person.get("user_id")), {})
        if (
            any(
                row.get(key) != value
                for key, value in (
                    ("email", spec.email),
                    ("username", spec.username),
                    ("display_name", spec.name),
                    ("job_title", spec.title),
                    ("role", spec.role),
                    ("status", spec.status),
                )
            )
            or row.get("is_deleted") is not False
        ):
            issues.append("a sample person's identity, role or account state differs")
        if spec.role == "guest":
            sponsor_id = expected.get(spec.sponsor or "", {}).get("user_id")
            expiry = row.get("expires_at")
            try:
                parsed = datetime.fromisoformat(expiry) if isinstance(expiry, str) else None
            except ValueError:
                parsed = None
            if (
                not sponsor_id
                or row.get("sponsor_user_id") != sponsor_id
                or parsed is None
                or parsed.tzinfo is None
                or parsed <= datetime.now(UTC)
            ):
                issues.append("a guest sponsor or future expiry differs")
        elif row.get("sponsor_user_id") is not None or row.get("expires_at") is not None:
            issues.append("an internal sample identity has guest-only settings")
    observed = {"people": len(actual) - int(admin_id in actual)}
    for status in ("active", "pending", "disabled"):
        observed[f"people_{status}"] = sum(
            row.get("status") == status for key, row in actual.items() if key != admin_id
        )
    for status in ("active", "pending", "disabled"):
        count = sum(person.status == status for person in specs)
        if observed[f"people_{status}"] != count:
            issues.append(f"sample {status} identity count differs")
    return observed, issues


def verify_sample_data(
    *,
    api_url: str,
    origin: str,
    admin_email: str,
    expected_admin_id: str,
    admin_password: str,
    run_directory: Path,
) -> SampleVerificationReport:
    manifest = read_run_manifest(run_directory, expected_admin_id)
    if manifest["status"] not in {"populated", "complete"}:
        return SampleVerificationReport(
            "incomplete",
            run_directory,
            {},
            ("Population did not finish; reconcile the original journal and rebuild.",),
        )
    pack, counts = _manifest_plan(manifest)
    dataset = build_dataset(
        cast(SampleProfile, manifest["profile"]),
        manifest["seed"],
        date.fromisoformat(manifest["anchor_date"]),
        organization=pack,
        module_counts_override=counts,
        host_acceptance=manifest.get("host_acceptance") is True,
    )
    observed: dict[str, int] = {}
    issues: list[str] = []
    organization_id = manifest.get("organization_id")
    journal = run_directory / "verification-requests.jsonl"
    with SampleClient(api_url, origin, journal, organization_id) as client:
        if client.login(admin_email, admin_password).status_code != 200:
            raise SampleVerificationError("Verification administrator login failed")
        try:
            response = client.request("GET", "/api/auth/me")
            if response.status_code != 200 or response.json().get("id") != expected_admin_id:
                raise SampleVerificationError("Verification administrator identity differs")
            counts, record_issues = verify_records_and_relationships(
                client,
                dataset=dataset,
                mappings=manifest["mappings"],
                actor_ids=manifest["actor_ids"],
                started_at=manifest["started_at"],
                finished_at=manifest["finished_at"],
                require_complete=True,
            )
            observed.update(counts)
            issues.extend(record_issues)
            history_counts, history_issues = verify_history(
                client,
                dataset=dataset,
                mappings=manifest["mappings"],
                actor_ids=manifest["actor_ids"],
                skipped=manifest.get("history_skipped", []),
                started_at=manifest["started_at"],
                finished_at=manifest["finished_at"],
            )
            observed.update(history_counts)
            issues.extend(history_issues)
            rejection_counts, rejection_issues = verify_rejections(
                client,
                results=manifest.get("expected_failures", []),
                started_at=manifest["started_at"],
                finished_at=manifest["finished_at"],
                organization=dataset.organization,
            )
            observed.update(rejection_counts)
            issues.extend(rejection_issues)
            people_counts, people_issues = _people_issues(
                client, manifest, expected_admin_id, organization=dataset.organization
            )
            observed.update(people_counts)
            issues.extend(people_issues)
            final_people = _people(
                final_people_pack(dataset.organization, read_phase_plan(manifest))
            )
            isolation_counts, isolation_issues = verify_isolation(
                client,
                organization_id=organization_id,
                api_url=api_url,
                origin=origin,
                journal=journal,
                admin_login=(admin_email, admin_password),
                member_logins=roster_logins(
                    run_directory / "credentials.json",
                    (p.key for p in final_people if p.role == "member" and p.status == "active"),
                ),
            )
            observed.update(isolation_counts)
            issues.extend(isolation_issues)
            configuration_maps = manifest["mappings"]
            if "control_plan" in manifest:
                control_counts, control_issues = verify_controls(
                    client, dataset, manifest, expected_admin_id
                )
                observed.update(control_counts)
                issues.extend(control_issues)
                try:
                    configuration_maps = configuration_mappings(manifest, dataset)
                except SampleVerificationError:
                    issues.append("Restored Sandbox Test mappings are missing or ambiguous")
            configuration_counts, configuration_issues = verify_configuration(
                client,
                dataset=dataset,
                mappings=configuration_maps,
                people=manifest["people"],
                phase_actions=read_phase_plan(manifest),
            )
            observed.update(configuration_counts)
            issues.extend(configuration_issues)
            phase_counts, phase_issues = verify_phases(
                client, dataset=dataset, manifest=manifest, admin_id=expected_admin_id
            )
            observed.update(phase_counts)
            issues.extend(phase_issues)
            expected_content = dict(manifest["content_counts"])
            if any(
                isinstance(row, Mapping) and row.get("action_key") == "control:chart_lifecycle"
                for row in manifest.get("control_results", [])
            ):
                from operations.sample.controls.charts_verification import (
                    certify_retained_chart_dashboards,
                )

                retained, retained_issues = certify_retained_chart_dashboards(
                    client, dataset, manifest, expected_admin_id, run_directory
                )
                issues.extend(retained_issues)
                expected_content["dashboards"] += len(retained)
            content = verify_content(
                client,
                run_manifest={"expected": expected_content},
                mappings=manifest["mappings"],
                organization=dataset.organization,
            )
            observed.update(content)
            if content.get("content_complete") != 1:
                issues.append("Board or OpenView content did not satisfy complete readback")
            trigger_counts, trigger_issues = _verify_triggers(
                client, manifest, organization=dataset.organization
            )
            observed.update(trigger_counts)
            issues.extend(trigger_issues)
        finally:
            client.request("POST", "/api/auth/logout")
    if "control_plan" in manifest:
        route_counts, route_issues = verify_route_coverage(
            run_directory, host_acceptance=dataset.host_acceptance
        )
        observed.update(route_counts)
        issues.extend(route_issues)
    return SampleVerificationReport(
        "incomplete" if issues else "complete",
        run_directory,
        observed,
        tuple(dict.fromkeys(issues)),
    )


def trigger_evidence_issues(
    evidence: list[dict[str, Any]],
    runs: list[Mapping[str, Any]],
    record_data: Mapping[str, Mapping[str, Any]],
) -> list[str]:
    by_id = {str(run.get("id")): run for run in runs}
    issues: list[str] = []
    for item in evidence:
        if item.get("enabled") is False:
            continue
        run_ids = item.get("run_ids")
        if not isinstance(run_ids, list) or not run_ids:
            issues.append("an exercised trigger has no recorded execution")
            continue
        for run_id in run_ids:
            run = by_id.get(str(run_id), {})
            details = run.get("details")
            if (
                run.get("triggerName") != item.get("name")
                or run.get("state") != "succeeded"
                or not isinstance(details, Mapping)
                or not isinstance(details.get("actionsApplied"), int)
                or details["actionsApplied"] < 1
            ):
                issues.append("a recorded trigger execution is missing or did not apply its action")
        data = record_data.get(str(item.get("target_logical_id")), {})
        if data.get(str(item.get("target_field_id"))) != item.get("expected_value"):
            issues.append("a trigger target no longer contains the expected result")
    return issues


def _verify_triggers(
    client: SampleClient,
    manifest: Mapping[str, Any],
    *,
    organization: OrganizationPack | None = None,
) -> tuple[dict[str, int], list[str]]:
    pack = organization or default_pack()
    evidence = manifest.get("trigger_evidence", [])
    mutations = manifest.get("mutation_evidence", [])
    issues: list[str] = []
    if not isinstance(evidence, list) or len(evidence) != len(pack.generators.trigger_keys):
        return {}, ["trigger evidence must cover all authored rules"]
    if not isinstance(mutations, list) or len(mutations) != len(pack.blueprint.patch_trigger_keys):
        issues.append("trigger evidence must include the authored record updates")
        mutations = []
    runs = list_all_rows(client, "/api/sandbox/trigger-runs", page_size=50)
    record_data: dict[str, Mapping[str, Any]] = {}
    record_ids = manifest["mappings"].get("records", {})
    for item in evidence:
        if item.get("enabled") is False:
            continue
        logical = item.get("target_logical_id")
        record_id = record_ids.get(logical)
        if not record_id:
            issues.append("trigger target mapping is missing")
            continue
        response = client.request("GET", f"/api/records/{record_id}")
        if response.status_code != 200:
            issues.append("trigger target readback failed")
            continue
        data = response.json().get("data")
        if isinstance(data, dict):
            record_data[logical] = data
    issues.extend(trigger_evidence_issues(evidence, runs, record_data))
    response = client.request("GET", "/api/sandbox/document")
    if response.status_code != 200:
        issues.append("published trigger configuration could not be read")
    else:
        triggers = response.json().get("document", {}).get("triggers", [])
        for item in evidence:
            if item.get("enabled") is False and not any(
                trigger.get("name") == item.get("name") and trigger.get("enabled") is False
                for trigger in triggers
            ):
                issues.append("a scheduled trigger is not disabled in its saved configuration")
    matches = 0
    for mutation in mutations:
        rows = list_all_rows(
            client,
            "/api/audit-logs",
            params={
                "entity_type": "records",
                "entity_id": mutation.get("record_id"),
                "created_after": manifest["started_at"],
                "created_before": manifest["finished_at"],
            },
        )
        if mutation.get("request_id") and any(
            row.get("entity_id") == mutation.get("record_id")
            and row.get("performed_by") == mutation.get("actor_id")
            and row.get("action") == "update"
            and row.get("request_id") == mutation["request_id"]
            and row.get("request_method") == "PATCH"
            and row.get("request_path") == mutation.get("request_path")
            for row in rows
        ):
            matches += 1
        else:
            issues.append(
                "an authored record update lacks matching actor and request audit evidence"
            )
    return {"trigger_runs": len(runs), "record_update_audit_matches": matches}, issues
