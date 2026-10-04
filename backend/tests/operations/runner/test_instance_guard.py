from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from sqlalchemy.pool import NullPool

from app.core.config import instance
from app.core.config.instance import (
    InstanceTarget,
    InstanceTargetError,
    assert_database_url,
    assert_instance_target,
    assert_local_backend_url,
    instance_target_for_process,
    load_instance_target,
    migration_advisory_lock,
)
from tests.conftest import guarded_create_engine


def _environment() -> dict[str, str]:
    return {
        "OPENSLATE_INSTANCE_ID": "openslate-boards-a1b2c3d4",
        "POSTGRES_HOST": "127.0.0.1",
        "POSTGRES_PORT": "55432",
        "POSTGRES_DATABASE": "postgres",
    }


def _write_attestation(path: Path, *, cluster_name: str = "openslate-boards-a1b2c3d4") -> None:
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "version": 2,
                "instance_id": "openslate-boards-a1b2c3d4",
                "compose_project": "openslate-boards-a1b2c3d4",
                "postgres": {
                    "host": "127.0.0.1",
                    "port": 55432,
                    "database": "postgres",
                    "cluster_name": cluster_name,
                },
                "compose": {
                    "volume": "openslate-boards-a1b2c3d4_supabase-db-data",
                    "network": "openslate-boards-a1b2c3d4_provider",
                },
                "ownership": {
                    "compose_project": "openslate-boards-a1b2c3d4",
                    "container_port": 5432,
                    "container_id": "a" * 64,
                    "host_port": 55432,
                    "image": instance.SUPABASE_DB_IMAGE,
                    "network_id": "b" * 64,
                    "working_dir": str(instance.REPOSITORY_ROOT / "infra" / "supabase"),
                    "network": "openslate-boards-a1b2c3d4_provider",
                    "volume": "openslate-boards-a1b2c3d4_supabase-db-data",
                },
            }
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)


def test_load_instance_target_requires_owned_attestation_and_matching_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    attestation = tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json"
    _write_attestation(attestation)

    target = load_instance_target(_environment())

    assert target == InstanceTarget(
        instance_id="openslate-boards-a1b2c3d4",
        host="127.0.0.1",
        port=55432,
        database="postgres",
        attestation_path=attestation,
        cluster_name="openslate-boards-a1b2c3d4",
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("POSTGRES_PORT", "55322"),
        ("POSTGRES_DATABASE", "openslate"),
        ("OPENSLATE_INSTANCE_ID", "openslate-other-a1b2c3d4"),
    ],
)
def test_load_instance_target_rejects_wrong_static_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    attestation = tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json"
    _write_attestation(attestation)
    environment = _environment()
    environment[name] = value

    with pytest.raises(InstanceTargetError):
        load_instance_target(environment)


def test_load_instance_target_rejects_unknown_or_shared_ownership(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    attestation = tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json"
    _write_attestation(attestation)
    payload = json.loads(attestation.read_text(encoding="utf-8"))
    payload["compose"]["volume"] = "supabase-db-data"
    attestation.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(InstanceTargetError, match="ownership"):
        load_instance_target(_environment())


@pytest.mark.parametrize(
    ("database", "user", "cluster_name"),
    [
        ("other", "openslate_runtime", "openslate-boards-a1b2c3d4"),
        ("postgres", "openslate_owner", "openslate-boards-a1b2c3d4"),
        ("postgres", "openslate_runtime", "other-cluster"),
    ],
)
def test_assert_instance_target_rejects_live_database_user_or_cluster(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, database: str, user: str, cluster_name: str
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    attestation = tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json"
    _write_attestation(attestation)
    target = load_instance_target(_environment())
    connection = MagicMock()
    connection.exec_driver_sql.return_value.one.return_value = (database, user, cluster_name)

    with pytest.raises(InstanceTargetError):
        assert_instance_target(connection, target, expected_user="openslate_runtime")


def test_assert_instance_target_accepts_the_attested_live_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    attestation = tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json"
    _write_attestation(attestation)
    target = load_instance_target(_environment())
    connection = MagicMock()
    connection.exec_driver_sql.return_value.one.return_value = (
        "postgres",
        "openslate_runtime",
        "openslate-boards-a1b2c3d4",
    )

    assert_instance_target(connection, target, expected_user="openslate_runtime")
    connection.exec_driver_sql.assert_called_once()


@pytest.mark.parametrize(
    "url",
    [
        "postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55322/postgres",
        "postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55432/other",
        "postgresql+psycopg://openslate_owner:secret@127.0.0.1:55432/postgres",
    ],
)
def test_assert_database_url_rejects_wrong_port_database_or_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    attestation = tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json"
    _write_attestation(attestation)
    target = load_instance_target(_environment())

    with pytest.raises(InstanceTargetError):
        assert_database_url(url, target, expected_user="openslate_runtime")


def test_migration_advisory_lock_is_held_for_the_entire_migration_block() -> None:
    connection = MagicMock()

    with migration_advisory_lock(connection):
        assert connection.exec_driver_sql.call_count == 1

    calls = [str(call.args[0]) for call in connection.exec_driver_sql.call_args_list]
    assert len(calls) == 1
    assert "pg_advisory_xact_lock" in calls[0]


def test_migration_advisory_lock_preserves_migration_failure() -> None:
    connection = MagicMock()
    failure = RuntimeError("migration failed")

    with pytest.raises(RuntimeError) as raised:
        with migration_advisory_lock(connection):
            raise failure

    assert raised.value is failure
    assert connection.exec_driver_sql.call_count == 1


@pytest.mark.integration
def test_migration_lock_remains_held_until_transaction_commit() -> None:
    database_url = os.environ.get("MIGRATION_DATABASE_URL")
    if database_url is None:
        pytest.skip("Use the runner-owned PostgreSQL database for migration lock persistence")
    engine = guarded_create_engine(database_url, poolclass=NullPool)
    try:
        with engine.connect() as first, engine.connect() as second:
            with first.begin():
                with migration_advisory_lock(first):
                    pass
                acquired = second.exec_driver_sql(
                    "SELECT pg_try_advisory_xact_lock(hashtext(%s))", ("openslate:alembic",)
                ).scalar_one()
                assert acquired is False
                second.rollback()

            with second.begin():
                acquired = second.exec_driver_sql(
                    "SELECT pg_try_advisory_xact_lock(hashtext(%s))", ("openslate:alembic",)
                ).scalar_one()
                assert acquired is True
    finally:
        engine.dispose()


@pytest.mark.parametrize("url", ["https://api.example.test:8000", "http://127.0.0.1:8001"])
def test_seed_api_url_must_be_this_worktrees_loopback_listener(url: str) -> None:
    with pytest.raises(InstanceTargetError):
        assert_local_backend_url(url, expected_port=8000)


def test_seed_api_url_accepts_configured_loopback_listener() -> None:
    assert_local_backend_url("http://localhost:8000", expected_port=8000)


def _docker_ownership_facts() -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    identity = "openslate-boards-a1b2c3d4"
    volume = f"{identity}_supabase-db-data"
    network = f"{identity}_provider"
    labels = {
        "com.docker.compose.project": identity,
        "com.docker.compose.project.working_dir": str(
            instance.REPOSITORY_ROOT / "infra" / "supabase"
        ),
        "com.docker.compose.service": "db",
    }
    container: dict[str, object] = {
        "Id": "a" * 64,
        "State": {"Running": True},
        "Config": {"Labels": labels, "Image": instance.SUPABASE_DB_IMAGE},
        "Mounts": [
            {
                "Type": "volume",
                "Destination": "/var/lib/postgresql/data",
                "Name": volume,
            }
        ],
        "NetworkSettings": {"Networks": {network: {"NetworkID": "b" * 64}}},
        "HostConfig": {
            "PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "55432"}]}
        },
    }
    network_resource: dict[str, object] = {
        "Id": "b" * 64,
        "Labels": {
            "com.docker.compose.project": identity,
            "com.docker.compose.network": "provider",
        },
    }
    volume_resource: dict[str, object] = {
        "Labels": {
            "com.docker.compose.project": identity,
            "com.docker.compose.volume": "supabase-db-data",
        }
    }
    return container, network_resource, volume_resource


def test_process_target_rechecks_live_container_network_and_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    _write_attestation(tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json")
    container, network, volume = _docker_ownership_facts()
    inspected = iter(([container], [network], [volume]))
    calls: list[list[str]] = []

    def inspect(arguments: list[str]) -> object:
        calls.append(arguments)
        return next(inspected)

    monkeypatch.setattr(instance, "_docker_json", inspect)
    process = {
        **_environment(),
        "ENVIRONMENT": "development",
    }

    target = instance_target_for_process(
        "postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55432/postgres",
        "openslate_runtime",
        process,
    )

    assert target is not None
    assert calls == [
        ["inspect", "a" * 64],
        ["network", "inspect", "openslate-boards-a1b2c3d4_provider"],
        ["volume", "inspect", "openslate-boards-a1b2c3d4_supabase-db-data"],
    ]


def test_process_target_rejects_live_volume_not_mounted_by_attested_container(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    _write_attestation(tmp_path / ".agent-runtime" / "instances" / "openslate-boards-a1b2c3d4.json")
    container, network, volume = _docker_ownership_facts()
    inspected = iter(([container], [network], [volume]))
    container["Mounts"] = [
        {"Type": "volume", "Destination": "/var/lib/postgresql/data", "Name": "other-data"}
    ]
    monkeypatch.setattr(instance, "_docker_json", lambda _arguments: next(inspected))

    with pytest.raises(InstanceTargetError, match="Live Docker ownership"):
        instance_target_for_process(
            "postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55432/postgres",
            "openslate_runtime",
            {**_environment(), "ENVIRONMENT": "development"},
        )


def test_production_target_is_explicit_and_does_not_require_local_docker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = {
        **_environment(),
        "ENVIRONMENT": "production",
    }
    monkeypatch.setattr(
        instance,
        "_docker_json",
        lambda _arguments: pytest.fail("production targets must not require local Docker"),
    )

    target = instance_target_for_process(
        "postgresql+psycopg://openslate_runtime:secret@127.0.0.1:55432/postgres",
        "openslate_runtime",
        process,
    )

    assert target == InstanceTarget(
        instance_id="openslate-boards-a1b2c3d4",
        host="127.0.0.1",
        port=55432,
        database="postgres",
        attestation_path=None,
        cluster_name="openslate-boards-a1b2c3d4",
    )
    connection = MagicMock()
    connection.exec_driver_sql.return_value.one.return_value = (
        "postgres",
        "openslate_runtime",
        "openslate-boards-a1b2c3d4",
    )
    assert_instance_target(connection, target, expected_user="openslate_runtime")


def test_health_instance_identity_is_non_secret_and_worktree_bound(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", Path("/tmp/openslate-worktree"))
    actual = instance.instance_identity_for_process(
        {"ENVIRONMENT": "development", "OPENSLATE_INSTANCE_ID": "openslate-boards-a1b2c3d4"}
    )
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", Path("/tmp/another-worktree"))
    expected = instance.instance_identity_for_process(
        {"ENVIRONMENT": "development", "OPENSLATE_INSTANCE_ID": "openslate-boards-a1b2c3d4"}
    )

    assert actual != expected
    assert actual is not None
    assert expected is not None
    assert len(actual) == 64
