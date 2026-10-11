"""An application connection must belong to the attested Supabase database."""

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.core.config import instance
from app.core.config.instance import InstanceTargetError, load_instance_target
from tests.operations.runner.instance_attestation import write_attestation

IDENTITY = "openslate-supabase-test"


def _values() -> dict[str, str]:
    return {
        "OPENSLATE_INSTANCE_ID": IDENTITY,
        "POSTGRES_HOST": "127.0.0.1",
        "POSTGRES_PORT": "55432",
        "POSTGRES_DATABASE": "postgres",
    }


def test_target_accepts_only_the_versioned_provider_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    write_attestation(tmp_path, IDENTITY)
    target = load_instance_target(_values())
    assert target.database == "postgres"
    assert target.cluster_name == IDENTITY
    write_attestation(tmp_path, IDENTITY, legacy=True)
    with pytest.raises(InstanceTargetError):
        load_instance_target(_values())


def test_live_guard_rejects_standalone_postgres_even_with_matching_labels(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(instance, "REPOSITORY_ROOT", tmp_path)
    write_attestation(tmp_path, IDENTITY)
    target = load_instance_target(_values())
    container = {
        "Id": "a" * 64,
        "State": {"Running": True},
        "Config": {
            "Image": instance.SUPABASE_DB_IMAGE,
            "Labels": {
                "com.docker.compose.project": IDENTITY,
                "com.docker.compose.project.working_dir": str(tmp_path),
                "com.docker.compose.service": "postgres",
            },
        },
        "Mounts": [
            {
                "Type": "volume",
                "Destination": "/var/lib/postgresql/data",
                "Name": f"{IDENTITY}_supabase-db-data",
            }
        ],
        "NetworkSettings": {"Networks": {f"{IDENTITY}_provider": {"NetworkID": "b" * 64}}},
        "HostConfig": {
            "PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "55432"}]}
        },
    }
    network = {
        "Id": "b" * 64,
        "Labels": {
            "com.docker.compose.project": IDENTITY,
            "com.docker.compose.network": "provider",
        },
    }
    volume = {
        "Labels": {
            "com.docker.compose.project": IDENTITY,
            "com.docker.compose.volume": "supabase-db-data",
        }
    }
    inspected = iter(([container], [network], [volume]))
    monkeypatch.setattr(instance, "_docker_json", lambda _: next(inspected))
    with pytest.raises(InstanceTargetError, match="Live Docker ownership"):
        instance.assert_live_docker_ownership(target)


def test_production_target_checks_cluster_identity() -> None:
    target = instance.instance_target_for_process(
        "postgresql+psycopg://openslate_runtime:secret@db:5432/postgres",
        "openslate_runtime",
        {
            "ENVIRONMENT": "production",
            "OPENSLATE_INSTANCE_ID": IDENTITY,
            "POSTGRES_HOST": "db",
            "POSTGRES_PORT": "5432",
            "POSTGRES_DATABASE": "postgres",
        },
    )
    assert target is not None
    assert target.cluster_name == IDENTITY
    connection = MagicMock()
    connection.exec_driver_sql.return_value.one.return_value = (
        "postgres",
        "openslate_runtime",
        "another-customer",
    )
    with pytest.raises(InstanceTargetError):
        instance.assert_instance_target(connection, target, expected_user="openslate_runtime")


def test_production_rejects_a_different_database_name() -> None:
    with pytest.raises(InstanceTargetError):
        instance.instance_target_for_process(
            "postgresql+psycopg://openslate_runtime:secret@db:5432/customer",
            "openslate_runtime",
            {
                "ENVIRONMENT": "production",
                "OPENSLATE_INSTANCE_ID": IDENTITY,
                "POSTGRES_HOST": "db",
                "POSTGRES_PORT": "5432",
                "POSTGRES_DATABASE": "customer",
            },
        )
