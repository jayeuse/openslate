"""List every object of one private Storage bucket, folder by folder and page by page."""

from typing import Any

import httpx

PAGE_SIZE = 100
_MAX_FOLDERS = 10_000


class StorageListingError(RuntimeError):
    """The bucket inventory is unavailable or ambiguous; the message holds no provider detail."""


def _entries(client: httpx.Client, bucket: str, folder: str, offset: int) -> list[Any]:
    response = client.post(
        f"object/list/{bucket}",
        json={
            "prefix": folder,
            "limit": PAGE_SIZE,
            "offset": offset,
            "sortBy": {"column": "name", "order": "asc"},
        },
    )
    try:
        entries = response.json()
    except ValueError:
        raise StorageListingError("Storage returned an invalid response") from None
    if response.status_code != 200 or not isinstance(entries, list) or len(entries) > PAGE_SIZE:
        raise StorageListingError("The Storage bucket inventory is unavailable")
    return entries


def _size(entry: dict[str, Any]) -> int | None:
    metadata = entry.get("metadata")
    size = metadata.get("size") if isinstance(metadata, dict) else None
    return size if isinstance(size, int) and not isinstance(size, bool) else None


def list_bucket(client: httpx.Client, bucket: str) -> dict[str, int | None]:
    """Every object key in ``bucket`` with its stored size (None when Storage gives none).

    ``client`` has the Storage API base URL (``…/storage/v1/``) and the secret key. A
    folder is an entry without an ``id``; it is listed in its turn.
    """
    folders, seen, objects = [""], set[str](), dict[str, int | None]()
    while folders:
        folder = folders.pop()
        if folder in seen or len(seen) >= _MAX_FOLDERS:
            raise StorageListingError("The Storage bucket inventory is ambiguous")
        seen.add(folder)
        offset = 0
        while True:
            entries = _entries(client, bucket, folder, offset)
            for entry in entries:
                name = entry.get("name") if isinstance(entry, dict) else None
                if not isinstance(name, str) or not name or "/" in name or name in {".", ".."}:
                    raise StorageListingError("The Storage bucket inventory is invalid")
                key = f"{folder}/{name}" if folder else name
                if entry.get("id") is None:
                    folders.append(key)
                elif key in objects:
                    raise StorageListingError("The Storage bucket inventory is ambiguous")
                else:
                    objects[key] = _size(entry)
            if len(entries) < PAGE_SIZE:
                break
            offset += len(entries)
    return objects
