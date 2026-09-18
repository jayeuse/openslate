"""Fixed one-GET child; stdin holds credentials, stdout only a bounded binary frame."""

import json
import sys

import httpx

MAX_BYTES = 25 * 1024 * 1024


def missing_object(response: httpx.Response) -> bool:
    """Only an explicit object-key error proves absence, never a bucket/auth failure."""
    if response.status_code not in {400, 404}:
        return False
    payload_bytes = bytearray()
    for chunk in response.iter_bytes(4096):
        if len(payload_bytes) + len(chunk) > 8192:
            raise ValueError("Storage error response exceeds bounds")
        payload_bytes.extend(chunk)
    try:
        payload = json.loads(payload_bytes)
    except (ValueError, UnicodeDecodeError):
        return False
    return (
        isinstance(payload, dict)
        and payload.get("code") == "NoSuchKey"
        and str(payload.get("statusCode", "404")) == "404"
    )


def download(url: str, headers: dict[str, str], max_bytes: int) -> bytes:
    with httpx.Client(timeout=120, follow_redirects=False) as client:
        with client.stream("GET", url, headers=headers) as response:
            if missing_object(response):
                return b"N\0\0\0\0"
            response.raise_for_status()
            content = bytearray()
            for chunk in response.iter_bytes(64 * 1024):
                if len(content) + len(chunk) > max_bytes:
                    raise ValueError("Response exceeds bounds")
                content.extend(chunk)
            return b"D" + len(content).to_bytes(4, "big") + content


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        limit = request["max_bytes"]
        if not isinstance(limit, int) or not 0 <= limit <= MAX_BYTES:
            raise ValueError
        reply = download(request["url"], request["headers"], limit)
    except Exception:
        reply = b"E\0\0\0\0"
    sys.stdout.buffer.write(reply)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
