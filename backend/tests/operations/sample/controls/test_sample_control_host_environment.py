"""Prewritten topology refusal cases; no physical host acceptance is claimed."""

import copy
import hashlib
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from operations.backups.host import RunnerError
from operations.sample.phases.actions import SamplePhaseActionError


@pytest.fixture
def host_runtime(tmp_path):
    from operations.sample.controls.host_environment import HostControlRuntime

    # fmt: off
    return HostControlRuntime(
        host=Mock(), development_env_file=tmp_path / "original-development.env",
        origin="https://localhost:9443", ca_file=tmp_path / "owned-ca.pem",
        journal_path=tmp_path / "requests.jsonl", capture_development=Mock(return_value={}),
        stop_api=Mock(), start_api=Mock(), permission_probe=Mock(return_value=None),
        native_delivery=Mock())
    # fmt: on


def test_unadmitted_development_never_stops_the_owned_api_or_enters_production(host_runtime):
    from operations.sample.controls.host_environment import production_topology

    host_runtime.capture_development.side_effect = SamplePhaseActionError(
        "Original development installation is not admitted", step="host_development"
    )
    with pytest.raises(SamplePhaseActionError) as observed:
        with production_topology(host_runtime):
            pytest.fail("An unadmitted installation reached the production body")
    assert observed.value.step == "host_development"
    host_runtime.stop_api.assert_not_called()
    host_runtime.start_api.assert_not_called()
    host_runtime.native_delivery.assert_not_called()


def test_native_permission_refusal_precedes_any_api_stop_or_production_body(host_runtime):
    from operations.sample.controls.host_environment import production_topology

    host_runtime.permission_probe.side_effect = SamplePhaseActionError(
        "Native export permissions are not admitted", step="host_permissions"
    )
    with pytest.raises(SamplePhaseActionError) as observed:
        with production_topology(host_runtime):
            pytest.fail("A refused native permission prerequisite reached production")
    assert observed.value.step == "host_permissions"
    host_runtime.stop_api.assert_not_called()
    host_runtime.start_api.assert_not_called()
    host_runtime.native_delivery.assert_not_called()


class TopologyHost:
    """Only the Docker/runner process boundary is fake; the helper owns sequencing."""

    def __init__(self, root):
        from operations.backups.host import SERVICES

        self.root, self.phase, self.commands, self.fault = root, "development", [], None
        self.network = "retained-provider-network"
        # fmt: off
        self.config = SimpleNamespace(installation_id="owned-sample",
            project_name="openslate-supabase-local-owned-sample", compose_root=root / "compose",
            compose_files=(root / "compose/compose.yaml", root / "compose/compose.production.yaml"),
            provider_env_file=root / "production-provider.env",
            app_env_file=root / "production-app.env",
            deployment="production")
        # fmt: on
        self.services = SERVICES
        self.config_path, self.state_directory = root / "backup.json", root / "state"
        self.state_directory.mkdir(mode=0o700)
        self.directory = self.state_directory / self.config.installation_id
        # fmt: off
        self.volumes = [
            {"Name": self.config.project_name + "_" + name, "CreatedAt": "2026-10-01T00:00:00Z",
             "Driver": "local", "Mountpoint": "/owned/" + name,
             "Labels": {"com.docker.compose.project": self.config.project_name,
                        "com.docker.compose.volume": name}}
            for name in ("supabase-db-data", "supabase-db-config", "supabase-storage-data",
                         "supabase-studio-snippets")
        ]
        # fmt: on
        self.rows = self.containers_for("development", ("db", "auth", "mailpit"))
        self.containers = []
        self.pending, self.active_claim, self.api_running = 0, None, True

    def containers_for(self, phase, services):
        # fmt: off
        return [{"Id": phase + "-" + name, "Image": "sha256:" + "a" * 64,
                 "Config": {"Image": "frozen-image", "Labels": {
                     "com.docker.compose.project": self.config.project_name,
                     "com.docker.compose.service": name,
                     "com.docker.compose.project.working_dir": str(self.config.compose_root)}},
                 "Mounts": [], "State": {"Status": "running"},
                 "NetworkSettings": {"Networks": {self.config.project_name + "_provider": {
                     "NetworkID": self.network, "EndpointID": phase + name,
                     "IPAddress": "172.29.0.2"}}}}
                for name in sorted(services)]
        # fmt: on

    def labels(self, item):
        return item["Config"]["Labels"]

    def inventory(self):
        rows = copy.deepcopy(self.rows)
        if self.fault == "changed_container" and self.phase == "development":
            rows[0]["Image"] = "sha256:" + "f" * 64
        if self.fault == "network":
            network = next(iter(rows[0]["NetworkSettings"]["Networks"].values()))
            network["NetworkID"] = "replacement-network"
        return rows

    def docker_json(self, args):
        if args[:2] == ["network", "inspect"]:
            # fmt: off
            return [{"Id": self.network, "Name": self.config.project_name + "_provider",
                     "Labels": {"com.docker.compose.project": self.config.project_name,
                                "com.docker.compose.network": "provider"}}]
            # fmt: on
        if args[:2] == ["volume", "inspect"]:
            return copy.deepcopy(self.volumes)
        if args[:2] == ["container", "inspect"]:
            return [r for r in self.inventory() if r["Id"] in args[2:]]
        raise AssertionError("Unexpected Docker read shape")

    def check_readers(self, rows, permitted):
        if self.fault == "foreign_reader":
            raise RunnerError("admission_failed")

    def command(self, args, **kwargs):
        self.commands.append(args)
        if args[:2] == ["docker", "stop"]:
            for row in self.rows:
                if row["Id"] in args[2:]:
                    row["State"]["Status"] = "exited"
                    for network in row["NetworkSettings"]["Networks"].values():
                        network.update(EndpointID="", IPAddress="")
        elif args[:3] == ["docker", "container", "rm"]:
            self.rows = [r for r in self.rows if r["Id"] not in args[3:]]
        elif args[:2] == ["docker", "compose"]:
            self.phase = "production"
            self.rows = self.containers_for(self.phase, self.services)
            if self.fault == "partial_start":
                self.rows = self.rows[:2]
                raise RunnerError("restart_failed")
        elif "dev.py" in " ".join(args):
            self.phase = "development"
            self.rows = self.containers_for(self.phase, ("db", "auth", "mailpit"))
        elif "recover" in args:
            if self.fault == "unresolved_claim":
                raise RunnerError("recovery_required")
            db = next(r for r in self.rows if self.labels(r)["com.docker.compose.service"] == "db")
            db["State"]["Status"] = "running"
            self.bridge({"op": "inspect"})
            for row in self.rows:
                row["State"]["Status"] = "running"
            self.active_claim = None
            return b'{"state":"idle"}'
        elif "run" in args:
            return json.dumps(self.on_run()).encode()
        else:
            raise AssertionError("Unexpected effect boundary")
        return b""

    def compose(self, tail, *, failure):
        from operations.backups.host import Host

        Host.compose(self, tail, failure=failure)

    def admit(self):
        assert self.phase == "production" and len(self.rows) == len(self.services)
        self.containers = copy.deepcopy(self.rows)

    def active(self):
        return self.active_claim

    def bridge(self, command):
        db = next(r for r in self.rows if self.labels(r)["com.docker.compose.service"] == "db")
        if db["State"]["Status"] != "running":
            raise RunnerError("result_unconfirmed")
        if command["op"] == "inspect":
            return {"unresolved": None}
        assert command["op"] == "inspect-export"
        return {"unresolved": None, "claim": None, "cleanup_candidates": []}


@pytest.fixture
def topology_runtime(tmp_path, monkeypatch):
    from operations.sample.controls import host_environment as environment

    host = TopologyHost(tmp_path)
    (tmp_path / "development.env").write_text("private-fixture-configuration")
    (tmp_path / "development.env").chmod(0o600)
    physical = SimpleNamespace(
        parse_config=lambda _: host.config, _private=lambda *a, **k: None, BackupError=ValueError
    )
    monkeypatch.setattr(environment, "physical_archive", lambda: physical, raising=False)
    # fmt: off
    original = {
        "instance_id": host.config.installation_id, "project": host.config.project_name,
        "cluster_name": host.config.installation_id,
        "api_identity": "0" * 64, "production_api_identity": "e" * 64,
        "owner_user_id": "ff1d9bc4-b338-49bb-8b76-f94518390d75",
        "owner_provider_user_id": "3ed5a332-dddc-4da4-847b-66a18aa5ca0d",
        "provider_network_id": host.network,
        "provider_volumes": {v["Name"]: copy.deepcopy(v) for v in host.volumes},
        "containers": copy.deepcopy(host.rows),
        "api_process": {"pid": 1234, "argv_sha256": "a" * 64, "cwd": str(tmp_path),
            "env_source_sha256": hashlib.sha256(
                (tmp_path / "development.env").read_bytes()).hexdigest()},
        "pending_exports": 0, "unresolved_runs": 0, "observed_at": "2026-10-07T00:00:00Z",
    }
    # fmt: on

    def capture():
        assert host.phase == "development" and host.api_running
        return {
            **copy.deepcopy(original),
            "containers": copy.deepcopy(host.rows),
            "pending_exports": host.pending,
        }

    def stop_api(proof):
        assert proof["api_process"]["pid"] == 1234
        host.api_running = False

    def start_api(proof):
        assert host.phase == "development"
        host.api_running = True

    # fmt: off
    runtime = environment.HostControlRuntime(
        host=host, development_env_file=tmp_path / "development.env", origin="https://localhost:9443",
        ca_file=tmp_path / "ca.pem", journal_path=tmp_path / "requests.jsonl",
        capture_development=capture, stop_api=Mock(side_effect=stop_api),
        start_api=Mock(side_effect=start_api), permission_probe=Mock(), native_delivery=Mock())
    # fmt: on
    return runtime, host, original


def test_same_resources_survive_real_helper_sequence_and_unclaimed_work_is_reported(
    topology_runtime,
):
    from operations.sample.controls.host_environment import production_topology

    runtime, host, original = topology_runtime
    with production_topology(runtime):
        assert host.phase == "production" and not host.api_running
        assert not any(host.labels(r)["com.docker.compose.service"] == "mailpit" for r in host.rows)
        host.pending = 1  # A lost export response may leave an unclaimed job.
    assert host.phase == "development" and host.api_running
    assert {v["Name"]: v for v in host.volumes} == original["provider_volumes"]
    assert host.network == original["provider_network_id"]
    assert runtime.reconciliation["development_restored"] is True
    assert runtime.reconciliation["pending_exports"] == 1
    assert all(
        "down" not in cmd and "volume" not in cmd and "network" not in cmd for cmd in host.commands
    )


@pytest.mark.parametrize("fault", ("changed_container", "foreign_reader", "pending", "network"))
def test_changed_or_busy_original_resource_is_refused_before_api_stop(topology_runtime, fault):
    from operations.sample.controls.host_environment import production_topology

    runtime, host, _ = topology_runtime
    if fault == "pending":
        host.pending = 1
    else:
        host.fault = fault
    with pytest.raises(SamplePhaseActionError):
        with production_topology(runtime):
            pytest.fail("Unadmitted source entered production")
    runtime.stop_api.assert_not_called()
    assert host.phase == "development" and host.commands == []


def test_partial_start_is_restored_and_original_body_failure_remains_primary(topology_runtime):
    from operations.sample.controls.host_environment import production_topology

    runtime, host, _ = topology_runtime
    host.fault = "partial_start"
    with pytest.raises(SamplePhaseActionError):
        with production_topology(runtime):
            pytest.fail("Partial production inventory entered body")
    assert host.phase == "development" and host.api_running
    assert runtime.reconciliation["development_restored"] is True


@pytest.mark.parametrize("unresolved", (False, True))
def test_retained_claim_recovers_stopped_db_or_preserves_topology(topology_runtime, unresolved):
    from operations.sample.controls.host_environment import production_topology

    runtime, host, _ = topology_runtime

    def stop_database_then_fail() -> None:
        host.active_claim = {"claim_id": "owned-claim"}
        host.fault = "unresolved_claim" if unresolved else None
        for row in host.rows:
            row["State"]["Status"] = "exited"
        raise SamplePhaseActionError("Archive failed", step="host_runner")

    with pytest.raises(SamplePhaseActionError) as observed:
        with production_topology(runtime):
            stop_database_then_fail()
    assert observed.value.step == "host_runner"
    assert host.phase == ("production" if unresolved else "development")
    assert host.api_running is not unresolved
    assert (host.active_claim is not None) is unresolved
    assert runtime.reconciliation["development_restored"] is not unresolved
    if unresolved:
        runtime.start_api.assert_not_called()


def test_external_failure_text_is_safe_and_cleanup_failure_does_not_replace_it(topology_runtime):
    from operations.sample.controls.host_environment import production_topology

    runtime, host, _ = topology_runtime

    def claim_then_fail_privately() -> None:
        host.active_claim = {"claim_id": "owned-claim"}
        host.fault = "unresolved_claim"
        raise RuntimeError("private-provider-payload-must-not-be-reported")

    with pytest.raises(SamplePhaseActionError) as observed:
        with production_topology(runtime):
            claim_then_fail_privately()
    assert observed.value.step == "host_topology"
    assert "private-provider" not in str(observed.value)
    assert runtime.reconciliation["development_restored"] is False


def test_restoration_cannot_accept_a_different_development_process_identity(topology_runtime):
    from operations.sample.controls.host_environment import production_topology

    runtime, host, captured = topology_runtime
    with pytest.raises(SamplePhaseActionError) as observed:
        with production_topology(runtime):
            captured["api_identity"] = "f" * 64
    assert observed.value.step == "host_restore"
    assert host.phase == "development" and host.api_running
    assert runtime.reconciliation["development_restored"] is False


def test_missing_independent_production_identity_is_refused_before_stop(topology_runtime):
    from operations.sample.controls.host_environment import production_topology

    runtime, _, captured = topology_runtime
    del captured["production_api_identity"]
    with pytest.raises(SamplePhaseActionError):
        with production_topology(runtime):
            pytest.fail("Missing image-bound identity reached production")
    runtime.stop_api.assert_not_called()


@pytest.fixture
def native_proof(topology_runtime):
    from app.systems.manage.backups.schemas import BackupExportResponse, BackupRunResponse
    from operations.sample.journal import append_event
    from operations.sample.population.people import SampleActorCredential
    from tests.operations.sample.controls.test_sample_control_backups import BackupWire
    from tests.operations.sample.controls.test_sample_control_mfa import PASSWORD

    runtime, _, _ = topology_runtime
    wire = SimpleNamespace(policy={"schedule": "disabled", "retention_days": 30})
    source = BackupWire._run(wire, "Owned physical source")
    # fmt: off
    source.update(state="succeeded", snapshot_id="b" * 64, manifest_sha256="c" * 64,
                  verified_at="2026-10-07T00:00:01Z", finished_at="2026-10-07T00:00:01Z",
                  reconciled_at="2026-10-07T00:00:01Z")
    # fmt: on
    source = BackupRunResponse.model_validate(source)
    export_id = str(uuid4())
    # fmt: off
    exported = BackupExportResponse(id=export_id, backup_run_id=source.id, state="ready",
        requested_at=datetime.now(UTC), ready_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=24), size_bytes=26 * 1024 * 1024,
        sha256="d" * 64, failure_code=None)
    # fmt: on
    credential = SampleActorCredential(str(uuid4()), "owned@example.test", PASSWORD)
    ids = {key: str(uuid4()) for key in ("login", "identity", "admission", "content")}
    for key, method, path in (
        ("login", "POST", "/api/auth/login"),
        ("identity", "GET", "/api/auth/me"),
        ("admission", "POST", "/api/backups/exports/{export_id}/download-admission"),
        ("content", "GET", "/api/backups/exports/{export_id}/content"),
    ):
        attempt = str(uuid4())
        # fmt: off
        append_event(runtime.journal_path, {"event": "request_started", "attempt_id": attempt,
                                          "method": method, "route_template": path})
        append_event(runtime.journal_path, {"event": "request_finished", "attempt_id": attempt,
                                          "request_id": ids[key], "status_code": 200})
        # fmt: on
    # fmt: off
    observation = {
        "actor_id": credential.user_id, "backup_run_id": str(source.id), "export_id": export_id,
        "size_bytes": exported.size_bytes, "sha256": exported.sha256, "request_ids": ids,
        "native_download": True, "used_fetch_blob": False,
        "failure": None, "descriptors_released": True,
        "headers": {"cache_control": "no-store", "content_type": "application/octet-stream",
            "content_length": str(exported.size_bytes), "x_content_type_options": "nosniff",
            "accept_ranges": "none", "content_disposition":
            f'attachment; filename="openslate-backup-export-{export_id}.tar"'},
        "attempt_event": {"id": str(uuid4()), "event_type": "backup.export.download",
            "outcome": "attempt", "operation_id": export_id, "subject_id": export_id,
            "actor_id": credential.user_id, "source": "backup", "request_id": ids["content"],
            "request_method": "GET", "request_path": f"/api/backups/exports/{export_id}/content",
            "metadata": {"backup_run_id": str(source.id), "size_bytes": exported.size_bytes,
                         "sha256": exported.sha256}},
    }
    # fmt: on
    return runtime, source, exported, credential, observation


@pytest.mark.parametrize(
    "fault", ("../outside", "repository/../outside", "password", "repository/link")
)
def test_repository_extraction_refuses_escape_plaintext_or_links(tmp_path, fault):
    import io
    import tarfile

    from operations.sample.controls.host_verification import _extract_repository

    path, target = tmp_path / "archive.tar", tmp_path / "verification"
    target.mkdir(mode=0o700)
    with tarfile.open(path, "w") as archive:
        member = tarfile.TarInfo(fault)
        if fault.endswith("link"):
            member.type, member.linkname = tarfile.SYMTYPE, "../../outside"
            archive.addfile(member)
        else:
            member.size = 4
            archive.addfile(member, io.BytesIO(b"data"))
    with pytest.raises(SamplePhaseActionError):
        _extract_repository(path, target)
    assert not (tmp_path / "outside").exists()


def test_repository_extraction_keeps_the_fresh_encrypted_repository_only(tmp_path):
    import io
    import tarfile

    from operations.sample.controls.host_verification import _extract_repository

    path, target = tmp_path / "archive.tar", tmp_path / "verification"
    target.mkdir(mode=0o700)
    with tarfile.open(path, "w") as archive:
        for name in ("repository/config", "repository/data/00/" + "a" * 64):
            member = tarfile.TarInfo(name)
            member.size = 6
            archive.addfile(member, io.BytesIO(b"opaque"))
    repository = _extract_repository(path, target)
    assert (repository / "config").exists()
    assert (repository / "config").read_bytes() == b"opaque"
    assert {p.name for p in target.iterdir()} == {"repository"}


@pytest.mark.parametrize("fault", ("snapshot", "check", "wrong_password", "source_password", None))
def test_repository_check_and_password_isolation_cannot_be_assumed(
    native_proof, tmp_path, monkeypatch, fault
):
    from operations.sample.controls import host_verification as verification

    runtime, source, _, _, _ = native_proof
    runtime.host.config.restic_password_file = tmp_path / "source-password"
    runtime.host.config.restic_password_file.write_text("fixture-source-password")
    runtime.host.config.restic_password_file.chmod(0o600)
    password = "fixture-new-unicode-export-密碼"
    # fmt: off
    document = json.dumps({"format_version": 3,
        "source_installation_id": runtime.host.config.installation_id,
        "source_project": runtime.host.config.project_name, "deployment": "production"}).encode()
    # fmt: on
    source = source.model_copy(update={"manifest_sha256": hashlib.sha256(document).hexdigest()})

    def restic(host, stage, args, env, failure):
        supplied = env.get("RESTIC_PASSWORD")
        accepted = supplied == password or (
            fault == "wrong_password" and supplied != "fixture-source-password"
        )
        accepted = accepted or (
            fault == "source_password" and supplied == "fixture-source-password"
        )
        if not accepted or fault == "check" and "check" in args:
            raise RunnerError("verification_failed")
        if "snapshots" in args:
            return json.dumps(
                [{"id": "f" * 64, "paths": ["/owned/installation"]}]
                * (2 if fault == "snapshot" else 1)
            ).encode()
        if "dump" in args:
            return document
        return b""

    monkeypatch.setattr(verification, "restic", restic, raising=False)
    if fault is None:
        verification._verify_repository(runtime.host, tmp_path, source, password)
    else:
        with pytest.raises(SamplePhaseActionError):
            verification._verify_repository(runtime.host, tmp_path, source, password)
