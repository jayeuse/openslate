"""Create and verify the private OpenSlate Storage bucket."""

import argparse
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

import httpx

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config.environment import environment_inputs
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH

BUCKETS = ("openslate-ready",)


class StorageProvisionError(RuntimeError):
    """A safe Storage initialization failure."""


def _body(response: httpx.Response) -> dict[str, object]:
    try:
        value = response.json()
    except ValueError:
        raise StorageProvisionError("Storage returned invalid bucket metadata") from None
    if not isinstance(value, dict):
        raise StorageProvisionError("Storage returned invalid bucket metadata")
    return value


def provision_storage(
    values: Mapping[str, str], *, transport: httpx.BaseTransport | None = None,
) -> None:
    assert_provider_instance(
        values, database_url=values["DATABASE_URL"], expected_user="openslate_runtime",
    )
    try:
        with httpx.Client(
            base_url=values["SUPABASE_URL"].rstrip("/") + "/storage/v1/",
            headers={"apikey": values["SUPABASE_SECRET_KEY"]},
            timeout=10, follow_redirects=False, transport=transport,
        ) as client:
            for bucket in BUCKETS:
                response = client.get(f"bucket/{bucket}")
                body = _body(response)
                if response.status_code in {400, 404} and body.get("code") == "NoSuchBucket":
                    client.post("bucket", json={"id": bucket, "name": bucket, "public": False})
                    response = client.get(f"bucket/{bucket}")
                    body = _body(response)
                if (
                    response.status_code != 200 or body.get("id") != bucket
                    or body.get("public") is not False
                ):
                    raise StorageProvisionError("The OpenSlate bucket must exist and be private")
    except httpx.HTTPError:
        raise StorageProvisionError("Storage initialization is unavailable") from None


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args(argv)
    try:
        values = environment_inputs(DOTENV_PATH)
        if values.get("ENVIRONMENT", "").lower() not in {"development", "dev", "local"}:
            if not args.confirm:
                raise SystemExit("--confirm is required outside local development")
        provision_storage(values)
    except SystemExit:
        raise
    except Exception:
        raise SystemExit("Unable to initialize private Storage buckets") from None
    print("The OpenSlate Storage bucket is private and ready")


if __name__ == "__main__":
    main()
