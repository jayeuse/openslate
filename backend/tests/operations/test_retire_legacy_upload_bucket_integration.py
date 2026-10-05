"""Real-provider retirement of a legacy upload bucket on the runner-owned disposable stack."""

from __future__ import annotations

import os
from collections.abc import Iterator

import httpx
import pytest

from app.core.config.provider_instance import assert_provider_instance
from operations import retire_legacy_upload_bucket as operation
from tests.conftest import _guard_integration_database

pytestmark = pytest.mark.integration

LEGACY = operation.LEGACY_BUCKET
KEYS = ("0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210", "nested/key")


@pytest.fixture
def provider() -> Iterator[tuple[dict[str, str], httpx.Client]]:
    if not os.getenv("TEST_DATABASE_URL"):
        pytest.skip("Runner-owned Supabase Storage is required for this integration test")
    values = dict(os.environ)
    owner_url = values.get("MIGRATION_DATABASE_URL", "")
    if not owner_url:
        raise RuntimeError("Runner-owned PostgreSQL is required for Storage integration tests")
    _guard_integration_database(owner_url)
    assert_provider_instance(values, database_url=owner_url, expected_user="openslate_owner")
    key = values["SUPABASE_SECRET_KEY"]
    client = httpx.Client(
        base_url=values["SUPABASE_URL"].rstrip("/") + "/storage/v1/",
        headers={"apikey": key, "authorization": f"Bearer {key}"},
        timeout=10, follow_redirects=False, trust_env=False,
    )
    try:
        yield values, client
    finally:
        # Best effort: leave no legacy bucket behind if an assertion failed midway.
        if client.get(f"bucket/{LEGACY}").status_code == 200:
            client.post(f"bucket/{LEGACY}/empty")
            client.delete(f"bucket/{LEGACY}")
        client.close()


def test_execute_empties_and_removes_the_legacy_bucket_and_keeps_the_ready_bucket(
    provider: tuple[dict[str, str], httpx.Client],
) -> None:
    values, client = provider
    created = client.post("bucket", json={"id": LEGACY, "name": LEGACY, "public": False})
    assert created.status_code == 200, created.text
    for key in KEYS:
        stored = client.post(
            f"object/{LEGACY}/{key}",
            content=b"legacy upload bytes",
            headers={"content-type": "application/octet-stream"},
        )
        assert stored.status_code == 200, stored.text

    report = operation.retire_legacy_upload_bucket(values, execute=False)
    assert f"holds {len(KEYS)} objects" in report
    assert client.get(f"bucket/{LEGACY}").status_code == 200

    outcome = operation.retire_legacy_upload_bucket(values, execute=True)

    assert outcome.startswith(f"Deleted {len(KEYS)} objects")
    gone = client.get(f"bucket/{LEGACY}")
    assert gone.status_code in {400, 404} and gone.json().get("code") == "NoSuchBucket"
    assert client.get("bucket/openslate-ready").json().get("id") == "openslate-ready"
    assert operation.retire_legacy_upload_bucket(values, execute=True).startswith(
        "Nothing to retire"
    )
