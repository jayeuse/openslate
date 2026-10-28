"""Plan, populate, and verify organization sample data through UI APIs.

Run from backend/: ``uv run python operations/seed_sample_data.py plan``.
"""

from __future__ import annotations

import argparse
import getpass
import secrets
import sys
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx
from psycopg import connect

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config.development import is_local_development_host
from app.core.config.disposable_instance import PROVIDER_IMAGES
from app.core.config.environment import ConfigurationError, environment_inputs
from app.core.config.instance import (
    InstanceTarget,
    InstanceTargetError,
    _docker_json,
    assert_local_backend_url,
    assert_psycopg_target,
    instance_identity_for_process,
    instance_target_for_process,
)
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH
from operations.reset.auth import ResetAuth
from operations.reset_application_data import (
    ResetError,
    ResetStorage,
    _psycopg_database_url,
    build_reset_plan,
    required_environment,
    required_storage_environment,
    validate_local_database_url,
)
from operations.sample.failures import safe_operator_message
from operations.sample.organization import (
    create_sample_organization,
    organization_storage_objects,
    organization_usage,
    pack_administrator_email,
    pack_email_domains,
    pack_provider_accounts,
    sample_slug,
)
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.registry import default_pack, get_pack, pack_keys
from operations.sample.plan_summary import build_plan_summary as build_plan_summary
from operations.sample.plan_summary import print_plan as _print_plan
from operations.sample.scenario import build_dataset


class SampleOperationError(RuntimeError):
    """A safe operator-facing preflight or population failure."""


def _today_for_organization(key: str | None = None) -> date:
    return datetime.now(ZoneInfo(get_pack(key).identity.timezone)).date()


def _anchor_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError("anchor date must use YYYY-MM-DD") from None


def _required(values: Mapping[str, str], name: str) -> str:
    value = values.get(name, "").strip()
    if not value:
        raise SampleOperationError(f"{name} is required")
    return value


def _local_origin(value: str) -> None:
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme in {"http", "https"}
            and parsed.hostname is not None
            and is_local_development_host(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and parsed.path in {"", "/"}
            and not parsed.query
            and not parsed.fragment
            and parsed.port is not None
        )
    except (ValueError, UnicodeError):
        valid = False
    if not valid:
        raise InstanceTargetError("PUBLIC_ORIGIN must target a local development host")


def _component_ready(snapshot: Mapping[str, Any], name: str) -> bool:
    components = snapshot.get("components")
    if not isinstance(components, dict):
        return False
    component = components.get(name)
    return isinstance(component, dict) and component.get("status") == "ready"


def _assert_api_identity(api_url: str, expected_identity: str) -> Mapping[str, Any]:
    try:
        with httpx.Client(timeout=4, follow_redirects=False, trust_env=False) as client:
            health = client.get(f"{api_url}/api/health")
            if health.status_code != 200:
                raise SampleOperationError("The local API health endpoint is unavailable")
            if health.headers.get("X-OpenSlate-Instance") != expected_identity:
                raise SampleOperationError("The API identity does not match the owned instance")
            ready = client.get(f"{api_url}/api/ready")
            try:
                snapshot = ready.json()
            except ValueError:
                raise SampleOperationError("The API readiness response is invalid") from None
    except httpx.HTTPError:
        raise SampleOperationError("The configured local API could not be reached") from None
    if (
        ready.status_code != 200
        or not isinstance(snapshot, dict)
        or snapshot.get("status") != "ready"
    ):
        raise SampleOperationError("The local API dependencies are not ready")
    for component in ("database", "auth", "storage", "smtp"):
        if not _component_ready(snapshot, component):
            raise SampleOperationError(f"The local {component} dependency is not ready")
    return snapshot


def _environment_values() -> tuple[dict[str, str], InstanceTarget, str, str, str, float]:
    values = environment_inputs(DOTENV_PATH)
    if values.get("ENVIRONMENT", "").strip().casefold() not in {"development", "dev", "local"}:
        raise SampleOperationError(
            "Sample data commands are restricted to the owned local development instance"
        )
    migration_url, admin_email = required_environment(values)
    provider_url, provider_secret, timeout, _backend_host, backend_port = (
        required_storage_environment(values)
    )
    target = instance_target_for_process(migration_url, "openslate_owner", process=values)
    if target is None:
        raise InstanceTargetError("The local OpenSlate database target is unavailable")
    validate_local_database_url(migration_url, target)
    assert_provider_instance(values, database_url=migration_url, expected_user="openslate_owner")

    try:
        port = int(backend_port)
    except ValueError:
        raise SampleOperationError("BACKEND_PORT is invalid") from None
    api_url = _required(values, "BACKEND_URL").rstrip("/")
    assert_local_backend_url(api_url, expected_port=port)
    origin = _required(values, "PUBLIC_ORIGIN")
    _local_origin(origin)
    return values, target, admin_email, api_url, origin, timeout


def _assert_owned_mailpit(values: Mapping[str, str], target: InstanceTarget) -> str:
    """Verify the running, project-owned Mailpit and live Auth SMTP target."""
    try:
        port = int(_required(values, "SUPABASE_MAIL_PORT"))
        if not 1 <= port <= 65535:
            raise ValueError
        inspected = _docker_json(
            [
                "inspect",
                f"{target.instance_id}-auth-1",
                f"{target.instance_id}-mailpit-1",
            ]
        )
        if not isinstance(inspected, list) or len(inspected) != 2:
            raise ValueError
        auth, mailpit = inspected
        expected_workdir = str(Path(__file__).resolve().parents[2] / "infra" / "supabase")
        for service, container in (("auth", auth), ("mailpit", mailpit)):
            labels = container["Config"]["Labels"]
            if (
                labels.get("com.docker.compose.project") != target.instance_id
                or labels.get("com.docker.compose.service") != service
                or labels.get("com.docker.compose.project.working_dir") != expected_workdir
                or container["State"].get("Running") is not True
            ):
                raise ValueError
        if mailpit["Config"].get("Image") != PROVIDER_IMAGES["mailpit"]:
            raise ValueError
        auth_env = _docker_environment(auth)
        mailpit_env = _docker_environment(mailpit)
        if (
            auth_env.get("GOTRUE_SMTP_HOST") != "mailpit"
            or auth_env.get("GOTRUE_SMTP_PORT") != "1025"
        ):
            raise ValueError
        if mailpit_env.get("MP_SMTP_BIND_ADDR") != "0.0.0.0:1025":
            raise ValueError
        auth_network = auth["NetworkSettings"]["Networks"][f"{target.instance_id}_mail-egress"]
        mail_network = mailpit["NetworkSettings"]["Networks"][f"{target.instance_id}_mail-egress"]
        network_id = auth_network.get("NetworkID")
        inspected_network = _docker_json(
            [
                "network",
                "inspect",
                f"{target.instance_id}_mail-egress",
            ]
        )
        if (
            not isinstance(network_id, str)
            or network_id != mail_network.get("NetworkID")
            or not isinstance(inspected_network, list)
            or len(inspected_network) != 1
        ):
            raise ValueError
        network = inspected_network[0]
        labels = network.get("Labels")
        if (
            not isinstance(labels, dict)
            or network.get("Name") != f"{target.instance_id}_mail-egress"
            or network.get("Id") != network_id
            or labels.get("com.docker.compose.project") != target.instance_id
            or labels.get("com.docker.compose.network") != "mail-egress"
        ):
            raise ValueError
        bindings = mailpit["NetworkSettings"]["Ports"].get("8025/tcp")
        if bindings != [{"HostIp": "127.0.0.1", "HostPort": str(port)}]:
            raise ValueError
    except (AttributeError, IndexError, KeyError, TypeError, ValueError):
        raise SampleOperationError(
            "Mailpit ownership, loopback port, or Auth SMTP configuration does not match"
        ) from None
    return f"http://127.0.0.1:{port}"


def _docker_environment(container: Mapping[str, Any]) -> dict[str, str]:
    entries = container["Config"].get("Env")
    if not isinstance(entries, list):
        raise ValueError
    values: dict[str, str] = {}
    for entry in entries:
        if isinstance(entry, str) and "=" in entry:
            name, value = entry.split("=", 1)
            if name in values:
                raise ValueError
            values[name] = value
    return values


def _local_preflight(
    pack: OrganizationPack | None = None,
) -> tuple[dict[str, Any], str, str]:
    """Check the owned instance; with a pack, count only that pack's organization and people."""
    values, target, admin_email, api_url, _origin, _timeout = _environment_values()
    identity = instance_identity_for_process(values)
    if identity is None:
        raise InstanceTargetError("The local API identity is unavailable")
    _assert_api_identity(api_url, identity)
    mailpit_url = _assert_owned_mailpit(values, target)
    migration_url, _ = required_environment(values)
    provider_url, provider_secret, timeout, _backend_host, _backend_port = (
        required_storage_environment(values)
    )
    with connect(_psycopg_database_url(migration_url, target)) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
        assert_psycopg_target(connection, target, expected_user="openslate_owner")
        storage = ResetStorage(provider_url, provider_secret, timeout)
        object_keys = storage.list_object_keys()
        reset_plan = build_reset_plan(connection, admin_email, storage_object_keys=object_keys)
        slug = sample_slug(pack.identity.key) if pack is not None else None
        administrator = pack_administrator_email(pack) if pack is not None else ""
        # The pack organization, then its partner; each is absent or holds only the operator
        # and the pack administrator.
        usage, partner = (
            organization_usage(
                connection,
                sample_slug(pack.identity.key, partner=side),
                reset_plan.preserved_admin_id,
                pack_administrator=administrator,
            )
            if pack is not None
            else None
            for side in (False, True)
        )
        connection.rollback()
    found = [row for row in (usage, partner) if row is not None]
    if any(not row.administered for row in found):
        raise SampleOperationError("The pack organization is not run by the configured admin")
    provider_accounts = pack_provider_accounts(
        ResetAuth(provider_url, provider_secret, timeout),
        reset_plan.preserved_admin_provider_id,
        admin_email,
        pack_email_domains(pack) if pack is not None else frozenset(),
        # Resuming an existing pack organization ignores only its own pack administrator.
        ignored_emails=frozenset({administrator}) if usage is not None else frozenset(),
    )
    organization_id = usage.organization_id if usage is not None else None
    report = {
        "instance": target.instance_id,
        "alembic_head": reset_plan.alembic_head,
        "admin_eligible": True,
        "admin_id": str(reset_plan.preserved_admin_id),
        "database_rows": sum(reset_plan.counts.values()),
        "organization_slug": slug,
        "organization_id": str(organization_id) if organization_id is not None else None,
        "partner_organization_id": str(partner.organization_id) if partner is not None else None,
        "organization_members": sum(row.other_members for row in found),
        "organization_records": sum(row.records for row in found),
        "storage_objects": sum(
            organization_storage_objects(object_keys, row.organization_id) for row in found
        ),
        "provider_accounts": provider_accounts,
    }
    return report, api_url, mailpit_url


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "populate"):
        command = commands.add_parser(name, help=f"{name} the owned local sample dataset")
        command.add_argument(
            "--profile", choices=("small", "standard", "large"), default="standard"
        )
        command.add_argument(
            "--organization", choices=pack_keys(), default=default_pack().identity.key
        )
        command.add_argument("--seed", type=int, default=None)
        command.add_argument("--anchor-date", type=_anchor_date, default=None)
        if name == "populate":
            command.add_argument("--run-root", type=Path, required=True)
            command.add_argument("--admin-password-file", type=Path)
            # Owner-only JSON {"password": ...}: the kept testing password of the pack
            # administrator (admin@<pack>.test). Without it, the run generates one.
            command.add_argument("--administrator-password-file", type=Path)
    verify = commands.add_parser("verify", help="read back an existing private sample run")
    verify.add_argument("--run-directory", type=Path, required=True)
    verify.add_argument("--admin-password-file", type=Path)
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    mfa_observer: Callable[..., object] | None = None,
    host_control: Callable[..., object] | None = None,
) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command in {"plan", "populate"} and args.seed is None:
            args.seed = secrets.randbits(64)
        if args.command in {"plan", "populate"} and args.anchor_date is None:
            args.anchor_date = _today_for_organization(args.organization)
        pack = get_pack(args.organization) if args.command != "verify" else None
        report, api_url, mailpit_url = _local_preflight(pack)
        if args.command == "plan":
            dataset = build_dataset(
                args.profile,
                args.seed,
                args.anchor_date,
                organization=pack,
                host_acceptance=host_control is not None,
            )
            _print_plan(dataset, report, mailpit_url)
            return 0
        if args.command == "populate" and (
            report.get("organization_members") or report.get("organization_records")
        ):
            raise SampleOperationError(
                "The pack organization already holds sample data; reset before population"
            )
        if args.command == "populate" and report.get("storage_objects") != 0:
            raise SampleOperationError(
                "Private storage holds the pack organization's objects; reset before population"
            )
        if args.command == "populate" and report.get("provider_accounts") != 0:
            raise SampleOperationError(
                "Provider accounts of this pack remain; reset before population"
            )
        from operations.sample.population.run import (
            SamplePopulationReport,
            populate_sample_data,
            read_admin_password,
        )
        from operations.sample.verification.run import SampleVerificationReport, verify_sample_data

        values, target, admin_email, _url, origin, _timeout = _environment_values()
        password = (
            read_admin_password(args.admin_password_file, admin_email)
            if args.admin_password_file
            else getpass.getpass("Existing administrator password: ")
        )
        try:
            result: SamplePopulationReport | SampleVerificationReport
            if args.command == "populate":
                dataset = build_dataset(
                    args.profile,
                    args.seed,
                    args.anchor_date,
                    organization=pack,
                    host_acceptance=host_control is not None,
                )
                _print_plan(dataset, report, mailpit_url)
                assert pack is not None

                def create(partner: bool) -> str:
                    admin_id = UUID(str(report["admin_id"]))
                    return str(
                        create_sample_organization(values, target, pack, admin_id, partner=partner)
                    )

                administrator_password = (
                    read_admin_password(args.administrator_password_file, None)
                    if args.administrator_password_file
                    else None
                )
                organization_id = report.get("organization_id") or create(False)
                partner_id = report.get("partner_organization_id") or create(True)
                # ADMIN_EMAIL is the installation operator; it invites the pack administrator.
                result = populate_sample_data(
                    api_url=api_url,
                    origin=origin,
                    mailpit_url=mailpit_url,
                    operator_email=admin_email,
                    expected_operator_id=report["admin_id"],
                    operator_password=password,
                    run_root=args.run_root,
                    profile=args.profile,
                    seed=args.seed,
                    anchor_date=args.anchor_date,
                    organization=pack,
                    mfa_observer=mfa_observer,
                    host_control=host_control,
                    administrator_password=administrator_password,
                    organization_id=organization_id,
                    partner_organization_id=partner_id,
                )
            else:
                result = verify_sample_data(
                    api_url=api_url,
                    origin=origin,
                    operator_email=admin_email,
                    expected_operator_id=report["admin_id"],
                    operator_password=password,
                    run_directory=args.run_directory,
                )
        finally:
            del password
        print(f"status={result.status}")
        print(f"run_directory={result.run_directory}")
        for key in ("isolation_organizations", "isolation_refusals"):
            if key in result.observed:
                print(f"{key}={result.observed[key]}")
        for issue in result.issues:
            print(f"incomplete: {issue}")
        return 0 if result.status == "complete" else 1
    except (ConfigurationError, InstanceTargetError, ResetError, SampleOperationError) as error:
        print(f"{args.command} failed: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print(
            f"{args.command} stopped; inspect the private run journal before any further writes",
            file=sys.stderr,
        )
        return 2
    except Exception as error:
        message = safe_operator_message(error)
        journal_hint = "inspect the private run journal before any further writes"
        if message is None:
            print(f"{args.command} stopped; {journal_hint}", file=sys.stderr)
        else:
            print(
                f"{args.command} stopped: {message}; {journal_hint}",
                file=sys.stderr,
            )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
