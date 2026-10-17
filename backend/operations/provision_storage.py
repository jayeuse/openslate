"""Create and verify the private OpenSlate Storage buckets and their limits."""

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

IMAGES = ["image/png", "image/jpeg"]
# D17/D18: organization files up to 10 MiB; account avatars up to 2 MiB, images only.
BUCKETS: dict[str, dict[str, object]] = {
    "openslate-ready": {"file_size_limit": 10 * 1024 * 1024, "allowed_mime_types": None},
    "openslate-avatars": {"file_size_limit": 2 * 1024 * 1024, "allowed_mime_types": IMAGES},
}


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
            for bucket, limits in BUCKETS.items():
                response = client.get(f"bucket/{bucket}")
                body = _body(response)
                if response.status_code in {400, 404} and body.get("code") == "NoSuchBucket":
                    client.post(
                        "bucket", json={"id": bucket, "name": bucket, "public": False, **limits}
                    )
                    response = client.get(f"bucket/{bucket}")
                    body = _body(response)
                elif response.status_code == 200 and body.get("public") is False and any(
                    body.get(name) != value for name, value in limits.items()
                ):
                    # Bring an existing private bucket to the current limits; never publish it.
                    client.put(f"bucket/{bucket}", json={"public": False, **limits})
                    response = client.get(f"bucket/{bucket}")
                    body = _body(response)
                if (
                    response.status_code != 200 or body.get("id") != bucket
                    or body.get("public") is not False
                    or any(body.get(name) != value for name, value in limits.items())
                ):
                    raise StorageProvisionError(
                        "The OpenSlate buckets must exist, be private, and carry their limits"
                    )
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
    print("The OpenSlate Storage buckets are private and ready")


if __name__ == "__main__":
    main()
