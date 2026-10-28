"""Authenticated API workflow for one private organization sample-data run."""

from __future__ import annotations

import json
import os
import re
import stat
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import SampleProfile
from operations.sample.scenario import build_dataset
from operations.sample.verification.core import (
    failure_report,
    list_all_rows,
    unique_rows_by_name,
)


class SamplePopulationError(RuntimeError):
    """A safe, unrecoverable population failure requiring reconciliation."""


@dataclass(frozen=True, slots=True)
class SamplePopulationReport:
    status: str
    run_directory: Path
    issues: tuple[str, ...]
    observed: Mapping[str, int]


def create_private_run_directory(root: Path, run_id: str) -> Path:
    """Create a new owner-only run directory; never reuse an interrupted run."""
    if not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise SamplePopulationError("Sample run ID is invalid")
    target = Path(root).expanduser()
    if not target.is_absolute():
        raise SamplePopulationError("Sample run directory must be an absolute path")
    if target.is_symlink():
        raise SamplePopulationError(
            "Sample run directory must be owner-only and cannot be a symlink"
        )
    try:
        target.mkdir(mode=0o700, parents=True, exist_ok=True)
        metadata = target.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or target.is_symlink():
            raise ValueError
        if os.name != "nt":
            if metadata.st_uid != os.getuid():
                raise ValueError
            if stat.S_IMODE(metadata.st_mode) & 0o077:
                raise ValueError
        run_directory = target / run_id
        run_directory.mkdir(mode=0o700)
        run_metadata = run_directory.lstat()
        if (
            not stat.S_ISDIR(run_metadata.st_mode)
            or run_directory.is_symlink()
            or (os.name != "nt" and stat.S_IMODE(run_metadata.st_mode) != 0o700)
        ):
            raise ValueError
        return run_directory
    except FileExistsError:
        raise SamplePopulationError(
            "Sample run directory already exists; do not resume it"
        ) from None
    except SamplePopulationError:
        raise
    except OSError:
        raise SamplePopulationError("Sample run directory must be new and owner-only") from None
    except ValueError:
        raise SamplePopulationError("Sample run directory must be owner-only") from None


def read_admin_password(path: Path, expected_email: str | None) -> str:
    """Read only a private administrator password file matching the local account.

    With ``expected_email`` None the file holds only a password (the pack administrator's).
    """
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise SamplePopulationError("Administrator credential path must be absolute")
    try:
        descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise SamplePopulationError("Administrator credential file is unavailable") from None
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise SamplePopulationError("Administrator credential file must be owner-only")
        if os.name != "nt" and (
            metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077
        ):
            raise SamplePopulationError("Administrator credential file must be owner-only")
        with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
            descriptor = -1
            payload = json.load(stream)
    except SamplePopulationError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise SamplePopulationError("Administrator credential file is invalid") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(payload, dict):
        raise SamplePopulationError("Administrator credential file is invalid")
    email = payload.get("email")
    password = payload.get("password")
    if expected_email is not None and (
        not isinstance(email, str) or email.strip().casefold() != expected_email.strip().casefold()
    ):
        raise SamplePopulationError(
            "Administrator credential identity does not match this instance"
        )
    if not isinstance(password, str) or not password:
        raise SamplePopulationError("Administrator password is missing")
    return password


def _write_manifest(directory: Path, document: Mapping[str, Any]) -> None:
    target = directory / "manifest.json"
    temporary = directory / f".manifest-{uuid4().hex}.tmp"
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(document, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        parent = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    except OSError:
        raise SamplePopulationError("Unable to persist the private run manifest") from None
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def refusal_detail(response: Any) -> str:
    """The API's error code and up to three field errors (field ID and rule, never a value)."""
    try:
        detail = response.json().get("detail")
    except (AttributeError, TypeError, ValueError):
        return ""
    if not isinstance(detail, Mapping):
        return ""
    code = detail.get("code")
    parts = [code] if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,64}", code) else []
    errors = detail.get("errors")
    for error in errors[:3] if isinstance(errors, list) else []:
        if isinstance(error, Mapping):
            field = str(error.get("field_id", ""))[:36]
            rule = str(error.get("message", ""))[:80]
            parts.append(f"{field}: {rule}" if field else rule)
    return f" ({'; '.join(parts)})" if parts else ""


def _api(
    client: SampleClient,
    method: str,
    path: str,
    *,
    body: Mapping[str, Any] | None = None,
    params: Mapping[str, str | int] | None = None,
    headers: Mapping[str, str] | None = None,
    expected: tuple[int, ...] = (200, 201),
) -> dict[str, Any]:
    response = client.request(method, path, json_body=body, params=params, headers=headers)
    if response.status_code not in expected:
        raise SamplePopulationError(
            f"{method} {path} returned HTTP {response.status_code}{refusal_detail(response)}"
        )
    if response.status_code == 204:
        return {}
    try:
        payload = response.json()
    except ValueError:
        raise SamplePopulationError(f"{method} {path} returned invalid JSON") from None
    if not isinstance(payload, dict):
        raise SamplePopulationError(f"{method} {path} returned an invalid object")
    return payload


def _record_if_match(row: Mapping[str, Any]) -> dict[str, str]:
    revision = row.get("updated_at")
    if not isinstance(revision, str) or not revision:
        raise SamplePopulationError("Record revision is unavailable before the edit")
    return {"If-Match": f'"{revision}"'}


def _api_id(row: Mapping[str, Any], label: str = "ID") -> str:
    value = row.get("id")
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError):
        raise SamplePopulationError(f"API {label} is missing a valid server ID") from None


def _login(client: SampleClient, email: str, password: str, *, expected_id: str) -> dict[str, Any]:
    response = client.login(email, password)
    if response.status_code != 200:
        raise SamplePopulationError(f"Login failed (HTTP {response.status_code})")
    user = _api(client, "GET", "/api/auth/me")
    if (
        str(user.get("id")) != expected_id
        or str(user.get("email", "")).casefold() != email.casefold()
        or user.get("status") != "active"
    ):
        raise SamplePopulationError(
            "Authenticated profile does not match the expected active identity"
        )
    return user


def _unique_mapping(
    rows: Sequence[Mapping[str, Any]], *, name_key: str, label: str
) -> dict[str, Mapping[str, Any]]:
    return unique_rows_by_name(rows, name_key=name_key, entity=label)


def _catalogue(
    admin: SampleClient, dataset: SampleDataset
) -> tuple[
    dict[str, dict[str, Any]],
    dict[str, dict[str, Any]],
    dict[str, list[Mapping[str, Any]]],
    dict[str, dict[str, Any]],
    dict[str, str],
    dict[str, str],
    dict[str, str],
]:
    """Resolve only unique published names and actual relationship metadata."""
    design = dataset.document.get("design")
    if not isinstance(design, Mapping):
        raise SamplePopulationError("Generated Sandbox design is invalid")
    raw_departments = design.get("departments")
    raw_modules = design.get("modules")
    raw_relationships = design.get("relationships")
    if not all(
        isinstance(rows, list) for rows in (raw_departments, raw_modules, raw_relationships)
    ):
        raise SamplePopulationError("Generated Sandbox structure is incomplete")

    live_departments = list_all_rows(admin, "/api/departments")
    by_department = _unique_mapping(
        live_departments, name_key="department_name", label="department"
    )
    departments: dict[str, dict[str, Any]] = {}
    department_ids: dict[str, str] = {}
    dept_key_by_doc_id: dict[str, str] = {}
    for doc in cast(list[dict[str, Any]], raw_departments):
        doc_id = _api_id({"id": doc.get("id")}, "Sandbox department")
        name = str(doc.get("name", ""))
        key = next((key for key, value in dataset.department_ids.items() if value == doc_id), None)
        row = by_department.get(name.strip().casefold())
        if key is None or row is None:
            raise SamplePopulationError("Published department mapping is incomplete")
        server_id = _api_id(row, "department")
        departments[key] = dict(row)
        department_ids[key] = server_id
        dept_key_by_doc_id[doc_id] = key
        admin.record_mapping("departments", key, server_id)
    if set(departments) != set(dataset.department_ids):
        raise SamplePopulationError("Published department set differs from the generated design")

    live_modules = list_all_rows(admin, "/api/modules")
    by_module = _unique_mapping(live_modules, name_key="module_name", label="module")
    module_key_by_doc_id: dict[str, str] = {}
    modules: dict[str, dict[str, Any]] = {}
    module_ids: dict[str, str] = {}
    module_doc_by_key: dict[str, dict[str, Any]] = {}
    for doc in cast(list[dict[str, Any]], raw_modules):
        doc_id = _api_id({"id": doc.get("id")}, "Sandbox module")
        name = str(doc.get("name", ""))
        key = next((key for key, value in dataset.module_ids.items() if value == doc_id), None)
        row = by_module.get(name.strip().casefold())
        department_key = dept_key_by_doc_id.get(str(doc.get("departmentId")))
        if (
            key is None
            or row is None
            or department_key is None
            or str(row.get("department_id")) != department_ids[department_key]
        ):
            raise SamplePopulationError("Published module mapping is missing or ambiguous")
        server_id = _api_id(row, "module")
        modules[key] = dict(row)
        module_ids[key] = server_id
        module_doc_by_key[key] = doc
        module_key_by_doc_id[doc_id] = key
        admin.record_mapping("modules", key, server_id)
    if set(modules) != set(dataset.module_ids):
        raise SamplePopulationError("Published module set differs from the generated design")

    field_ids: dict[str, str] = {}
    relationship_fields: dict[str, dict[str, Any]] = {}
    fields_by_module: dict[str, list[Mapping[str, Any]]] = {}
    for module_key in modules:
        live_fields = list_all_rows(
            admin, "/api/fields", params={"module_id": module_ids[module_key]}
        )
        fields_by_module[module_key] = [dict(row) for row in live_fields]
        by_field = _unique_mapping(live_fields, name_key="name", label="field")
        doc = module_doc_by_key[module_key]
        expected_fields = doc.get("fields")
        if not isinstance(expected_fields, list):
            raise SamplePopulationError("Generated module fields are invalid")
        for field_doc in expected_fields:
            if not isinstance(field_doc, dict):
                raise SamplePopulationError("Generated field definition is invalid")
            field_key = next(
                (
                    key
                    for key, value in dataset.field_ids[module_key].items()
                    if value == field_doc.get("id")
                ),
                None,
            )
            row = by_field.get(str(field_doc.get("name", "")).strip().casefold())
            if field_key is None or row is None or row.get("type") == "relationship":
                raise SamplePopulationError("Published field mapping is missing or ambiguous")
            field_id = _api_id(row, "field")
            field_ids[f"{module_key}:{field_key}"] = field_id
            admin.record_mapping("fields", f"{module_key}:{field_key}", field_id)

    cardinality = {
        "one-to-one": (False, False),
        "one-to-many": (True, False),
        "many-to-many": (True, True),
    }
    for doc in cast(list[dict[str, Any]], raw_relationships):
        relation_doc_id = _api_id({"id": doc.get("id")}, "Sandbox relationship")
        relation_key = next(
            (key for key, value in dataset.relationship_ids.items() if value == relation_doc_id),
            None,
        )
        source_key = module_key_by_doc_id.get(str(doc.get("sourceModuleId")))
        target_key = module_key_by_doc_id.get(str(doc.get("targetModuleId")))
        flags = cardinality.get(str(doc.get("cardinality")))
        if relation_key is None or source_key is None or target_key is None or flags is None:
            raise SamplePopulationError("Generated relationship dependencies are incomplete")
        candidates = [
            row
            for row in fields_by_module[source_key]
            if row.get("type") == "relationship"
            and str(row.get("name", "")).strip().casefold()
            == str(doc.get("name", "")).strip().casefold()
            and str(row.get("relationship_target_module_id")) == module_ids[target_key]
            and row.get("relationship_multiple_targets") is flags[0]
            and row.get("relationship_multiple_sources") is flags[1]
        ]
        if len(candidates) != 1:
            raise SamplePopulationError(
                "Published relationship field mapping is missing or ambiguous"
            )
        row = dict(candidates[0])
        relationship_fields[relation_key] = row
        field_id = _api_id(row, "relationship field")
        admin.record_mapping("relationships", relation_key, field_id)
    if set(relationship_fields) != set(dataset.relationship_ids):
        raise SamplePopulationError(
            "Published relationship definitions differ from the generated design"
        )
    return (
        departments,
        modules,
        fields_by_module,
        relationship_fields,
        department_ids,
        module_ids,
        field_ids,
    )


def populate_sample_data(
    *,
    api_url: str,
    origin: str,
    mailpit_url: str,
    operator_email: str,
    expected_operator_id: str,
    operator_password: str,
    run_root: Path,
    profile: SampleProfile,
    seed: int,
    anchor_date: date,
    organization: OrganizationPack | None = None,
    mfa_observer: Callable[..., object] | None = None,
    host_control: Callable[..., object] | None = None,
    organization_id: str | None = None,
    partner_organization_id: str | None = None,
    administrator_password: str | None = None,
) -> SamplePopulationReport:
    """Create a private run, populate through user APIs, then prove the readback."""
    dataset = build_dataset(
        profile,
        seed,
        anchor_date,
        organization=organization,
        host_acceptance=host_control is not None,
    )
    from operations.sample.phases.expectations import phase_plan_summary

    phases = phase_plan_summary(dataset)
    run_id = uuid4().hex
    directory = create_private_run_directory(run_root, run_id)
    manifest: dict[str, Any] = {
        "schema_version": 2,
        "organization": dataset.organization.identity.key,
        "span": dataset.organization.identity.span,
        "sampling_scope": dataset.organization.identity.sampling_scope,
        "module_counts": dict(dataset.module_counts),
        **phases,
        "phase_results": [],
        "planned_counts": {
            "records": len(dataset.records),
            "edges": len(dataset.edges),
            "phase_actions": phases["phase_counts"]["total"],
            **dataset.organization.content.supporting_counts,
        },
        "run_id": run_id,
        "status": "running",
        "profile": profile,
        "seed": seed,
        "anchor_date": anchor_date.isoformat(),
        "host_acceptance": host_control is not None,
        "admin_id": None,
        "operator_id": expected_operator_id,
        "organization_id": organization_id,
        "partner_organization_id": partner_organization_id,
        "started_at": None,
        "finished_at": None,
        "mappings": {},
        "actor_ids": {},
        "content_counts": {},
        "people": {},
        "trigger_evidence": [],
        "mutation_evidence": [],
        "observed": {},
        "stage": "preflight",
        "failed_step": None,
        "failure": None,
    }
    _write_manifest(directory, manifest)
    try:
        from operations.sample.population.workflow import _journal_mappings, run_population
        from operations.sample.verification.run import verify_sample_data

        observed = run_population(
            api_url=api_url,
            origin=origin,
            mailpit_url=mailpit_url,
            operator_email=operator_email,
            operator_password=operator_password,
            expected_operator_id=expected_operator_id,
            run_directory=directory,
            run_id=run_id,
            dataset=dataset,
            manifest=manifest,
            mfa_observer=mfa_observer,
            host_control=host_control,
            organization_id=organization_id,
            partner_organization_id=partner_organization_id,
            administrator_password=administrator_password,
        )
        manifest["mappings"] = _journal_mappings(directory / "requests.jsonl")
        manifest["observed"] = dict(observed)
        manifest["status"] = "populated"
        manifest["stage"] = "verification"
        manifest.pop("step", None)
        manifest["finished_at"] = datetime.now(UTC).isoformat()
        _write_manifest(directory, manifest)
        verification = verify_sample_data(
            api_url=api_url,
            origin=origin,
            operator_email=operator_email,
            expected_operator_id=expected_operator_id,
            operator_password=operator_password,
            run_directory=directory,
        )
        manifest["observed"].update(verification.observed)
        if verification.status != "complete":
            manifest["status"] = "incomplete"
            manifest["failed_step"] = "verification"
            manifest["failure"] = {
                "status": "incomplete",
                "stage": "verification",
                "step": "verification",
                "error_type": "SampleVerificationError",
                "message": "API readback found mismatches; reconcile before rebuilding.",
            }
            _write_manifest(directory, manifest)
            return SamplePopulationReport(
                "incomplete", directory, verification.issues, manifest["observed"]
            )
        manifest["stage"] = "complete"
        manifest["status"] = "complete"
        _write_manifest(directory, manifest)
        return SamplePopulationReport("complete", directory, (), manifest["observed"])
    except BaseException as error:
        stage_value = manifest.get("stage")
        stage = stage_value if isinstance(stage_value, str) else "unknown"
        step_value = manifest.get("step")
        failed_step = step_value if isinstance(step_value, str) and step_value else stage
        manifest["status"] = "populated" if stage in {"verification", "complete"} else "incomplete"
        manifest["finished_at"] = datetime.now(UTC).isoformat()
        manifest["failed_step"] = failed_step
        manifest["failure"] = failure_report(stage, error, step=failed_step)
        try:
            from operations.sample.population.workflow import _journal_mappings

            if (directory / "requests.jsonl").exists():
                manifest["mappings"] = _journal_mappings(directory / "requests.jsonl")
        except SamplePopulationError:
            pass
        _write_manifest(directory, manifest)
        return SamplePopulationReport(
            "incomplete",
            directory,
            (f"Population stopped during {stage}; reconcile before rebuilding.",),
            dict(manifest.get("observed", {})),
        )
