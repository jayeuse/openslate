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
from operations.sample.controls.comms_content_verification import verify_content_runs
from operations.sample.controls.comms_search import verify_search_runs
from operations.sample.controls.comms_settings import verify_settings_runs
from operations.sample.controls.verification import configuration_mappings, verify_controls
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack, get_pack
from operations.sample.packs.types import SampleProfile
from operations.sample.phases.expectations import final_people_pack, read_phase_plan
from operations.sample.phases.verification import verify_phases
from operations.sample.population.administrator import ADMINISTRATOR_KEY, administrator_identity
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
from operations.sample.verification.triggers import _verify_triggers
from operations.sample.verification.triggers import (
    trigger_evidence_issues as trigger_evidence_issues,
)


@dataclass(frozen=True)
class SampleVerificationReport:
    status: str
    run_directory: Path
    observed: Mapping[str, int]
    issues: tuple[str, ...]


def read_run_manifest(directory: Path, expected_operator_id: str) -> dict[str, Any]:
    """Reject public, redirected, mismatched or malformed run evidence.

    The run belongs to the operator who verifies it; its pack administrator is another account.
    """
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
    if value.get("operator_id") != expected_operator_id:
        raise SampleVerificationError("Run belongs to another operator")
    admin_id = value.get("admin_id")
    try:
        # A run that stopped before its invitation has no pack administrator yet.
        if (admin_id is not None or value.get("status") in {"populated", "complete"}) and (
            str(UUID(str(admin_id))) != admin_id or admin_id == expected_operator_id
        ):
            raise ValueError
    except ValueError:
        raise SampleVerificationError("Run has no valid pack administrator") from None
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
    for key in ("organization_id", "partner_organization_id"):
        organization_id = value.get(key)
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
    """The pack's people, its administrator and the operator, and no one else."""
    actual = {str(row.get("id")): row for row in list_all_rows(client, "/api/users")}
    expected = manifest["people"]
    issues: list[str] = []
    expected_ids = {str(person.get("user_id")) for person in expected.values()}
    pack = organization or default_pack()
    specs = _people(final_people_pack(pack, read_phase_plan(manifest)))
    staff = {admin_id, str(manifest.get("operator_id"))}
    if len(expected) != len(specs) or len(expected_ids) != len(specs):
        issues.append("identity manifest does not cover the pack's unique people")
    if set(actual) != expected_ids | staff or expected_ids & staff:
        issues.append("identity roster differs from the recorded run")
    administrator = actual.get(admin_id, {})
    if any(
        administrator.get(key) != value
        for key, value in administrator_identity(pack).items()
        if key in {"email", "username", "role", "status"}
    ) or administrator.get("is_deleted") is not False:
        issues.append("the pack administrator's identity, role or account state differs")
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
    observed = {"people": len(set(actual) - staff)}
    for status in ("active", "pending", "disabled"):
        observed[f"people_{status}"] = sum(
            row.get("status") == status for key, row in actual.items() if key not in staff
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
    operator_email: str,
    expected_operator_id: str,
    operator_password: str,
    run_directory: Path,
) -> SampleVerificationReport:
    """Read back as the run's pack administrator; installation readbacks use the operator."""
    manifest = read_run_manifest(run_directory, expected_operator_id)
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
    expected_admin_id = str(manifest["admin_id"])
    journal = run_directory / "verification-requests.jsonl"
    operator_login = (operator_email, operator_password)
    admin_login = roster_logins(run_directory / "credentials.json", [ADMINISTRATOR_KEY])
    with (
        SampleClient(api_url, origin, journal, organization_id) as client,
        SampleClient(api_url, origin, journal, organization_id) as operator,
    ):
        for signed, login, expected_id, label in (
            (operator, operator_login, expected_operator_id, "operator"),
            (client, admin_login[0] if admin_login else None, expected_admin_id, "administrator"),
        ):
            if login is None or signed.login(*login).status_code != 200:
                raise SampleVerificationError(f"Verification {label} login failed")
            response = signed.request("GET", "/api/auth/me")
            if response.status_code != 200 or response.json().get("id") != expected_id:
                raise SampleVerificationError(f"Verification {label} identity differs")
        try:
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
                operator_login=operator_login,
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
                    client, dataset, manifest, expected_admin_id, operator=operator
                )
                observed.update(control_counts)
                issues.extend(control_issues)
                settings_counts, settings_issues = verify_settings_runs(
                    client, dataset, manifest, expected_admin_id, api_url=api_url, origin=origin,
                    journal=journal, operator_login=operator_login,
                    operator_id=expected_operator_id,
                )
                observed.update(settings_counts)
                issues.extend(settings_issues)
                content_counts, content_issues = verify_content_runs(
                    client, dataset, manifest, expected_admin_id, api_url=api_url, origin=origin,
                    journal=journal, operator_login=operator_login,
                    operator_id=expected_operator_id,
                )
                observed.update(content_counts)
                issues.extend(content_issues)
                search_counts, search_issues = verify_search_runs(
                    client, dataset, manifest, expected_admin_id, api_url=api_url, origin=origin,
                    journal=journal, operator_login=operator_login,
                    operator_id=expected_operator_id,
                )
                observed.update(search_counts)
                issues.extend(search_issues)
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
            operator.request("POST", "/api/auth/logout")
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
