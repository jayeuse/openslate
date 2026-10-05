"""Retire the legacy upload bucket that releases with file scanning left in Storage.

One-time step for installations upgraded from a release that had file scanning. Run it
after `uv run alembic upgrade head`. Those releases kept new uploads in a second private
bucket, `openslate-quarantine`; the current release never reads it, so any bytes left
there are orphaned private data that purge and reset cannot reach.

The default is a dry run: it reports whether the bucket exists and how many objects it
holds, and changes nothing. `--execute` deletes every object, lists the bucket again to
prove it is empty, deletes the bucket, and asks the provider to confirm that the bucket
is gone. Outside local development `--execute` also needs `--confirm`. A missing bucket
means there is nothing to retire. Any provider failure exits non-zero without claiming
success; run the command again after the provider recovers. The `openslate-ready` bucket
is never read or changed.
"""

import argparse
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import httpx

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config.environment import environment_inputs
from app.core.config.provider_instance import assert_provider_instance
from app.core.config.settings import DOTENV_PATH

LEGACY_BUCKET = "openslate-quarantine"
_PAGE_SIZE = 100
_MAX_FOLDERS = 10_000


class RetirementError(RuntimeError):
    """A safe legacy bucket retirement failure; the message holds no provider detail."""


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        raise RetirementError("Storage returned an invalid response") from None


def _bucket_exists(client: httpx.Client) -> bool:
    response = client.get(f"bucket/{LEGACY_BUCKET}")
    body = _json(response)
    if not isinstance(body, dict):
        raise RetirementError("Storage returned invalid bucket metadata")
    if response.status_code in {400, 404} and body.get("code") == "NoSuchBucket":
        return False
    if response.status_code != 200 or body.get("id") != LEGACY_BUCKET:
        raise RetirementError("The legacy upload bucket state is unavailable")
    return True


def _list_objects(client: httpx.Client) -> tuple[str, ...]:
    """Every object key in the legacy bucket, descending into folders page by page."""
    folders, seen, objects = [""], set[str](), set[str]()
    while folders:
        folder = folders.pop()
        if folder in seen or len(seen) >= _MAX_FOLDERS:
            raise RetirementError("The legacy upload bucket inventory is ambiguous")
        seen.add(folder)
        offset = 0
        while True:
            response = client.post(
                f"object/list/{LEGACY_BUCKET}",
                json={
                    "prefix": folder,
                    "limit": _PAGE_SIZE,
                    "offset": offset,
                    "sortBy": {"column": "name", "order": "asc"},
                },
            )
            entries = _json(response)
            if (
                response.status_code != 200
                or not isinstance(entries, list)
                or len(entries) > _PAGE_SIZE
            ):
                raise RetirementError("The legacy upload bucket inventory is unavailable")
            for entry in entries:
                name = entry.get("name") if isinstance(entry, dict) else None
                if not isinstance(name, str) or not name or "/" in name or name in {".", ".."}:
                    raise RetirementError("The legacy upload bucket inventory is invalid")
                key = f"{folder}/{name}" if folder else name
                if entry.get("id") is None:
                    folders.append(key)
                elif key in objects:
                    raise RetirementError("The legacy upload bucket inventory is ambiguous")
                else:
                    objects.add(key)
            if len(entries) < _PAGE_SIZE:
                break
            offset += len(entries)
    return tuple(sorted(objects))


def _delete_objects(client: httpx.Client, keys: Sequence[str]) -> None:
    for start in range(0, len(keys), _PAGE_SIZE):
        response = client.request(
            "DELETE",
            f"object/{LEGACY_BUCKET}",
            json={"prefixes": list(keys[start : start + _PAGE_SIZE])},
        )
        if response.status_code != 200:
            raise RetirementError("Deleting the legacy upload objects failed")


def retire_legacy_upload_bucket(
    values: Mapping[str, str], *, execute: bool, transport: httpx.BaseTransport | None = None
) -> str:
    """Report, or with ``execute`` delete, the legacy bucket; return the outcome line."""
    assert_provider_instance(
        values, database_url=values["DATABASE_URL"], expected_user="openslate_runtime",
    )
    try:
        with httpx.Client(
            base_url=values["SUPABASE_URL"].rstrip("/") + "/storage/v1/",
            headers={"apikey": values["SUPABASE_SECRET_KEY"]},
            timeout=10, follow_redirects=False, trust_env=False, transport=transport,
        ) as client:
            if not _bucket_exists(client):
                return f"Nothing to retire: the bucket {LEGACY_BUCKET} does not exist"
            keys = _list_objects(client)
            if not execute:
                return (
                    f"Dry run: the bucket {LEGACY_BUCKET} exists and holds {len(keys)} "
                    "objects. Nothing was deleted; run again with --execute to delete them "
                    "and the bucket."
                )
            _delete_objects(client, keys)
            if _list_objects(client):
                raise RetirementError("The legacy upload bucket is not empty after deletion")
            response = client.delete(f"bucket/{LEGACY_BUCKET}")
            if response.status_code != 200:
                raise RetirementError("Deleting the legacy upload bucket failed")
            if _bucket_exists(client):
                raise RetirementError("The provider still reports the legacy upload bucket")
            return (
                f"Deleted {len(keys)} objects and the bucket {LEGACY_BUCKET}; "
                "the provider confirms the bucket is gone"
            )
    except httpx.HTTPError:
        raise RetirementError("Storage is unavailable") from None


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--execute", action="store_true", help="delete the objects and bucket")
    parser.add_argument("--confirm", action="store_true", help="required for --execute outside "
                        "local development")  # fmt: skip
    args = parser.parse_args(argv)
    try:
        values = environment_inputs(DOTENV_PATH)
        local = values.get("ENVIRONMENT", "").lower() in {"development", "dev", "local"}
        if args.execute and not local and not args.confirm:
            raise SystemExit("--confirm is required with --execute outside local development")
        print(retire_legacy_upload_bucket(values, execute=args.execute))
    except SystemExit:
        raise
    except RetirementError as error:
        raise SystemExit(f"Legacy upload bucket retirement failed: {error}") from None
    except Exception:
        raise SystemExit("Legacy upload bucket retirement failed") from None


if __name__ == "__main__":
    main()
