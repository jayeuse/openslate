"""Trusted one-shot SDK runner; never implements the clamd wire protocol."""

import errno
import json
import resource
import sys
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from io import BytesIO
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_BYTES = 25 * 1024 * 1024


class ServingManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    engine_version: str = Field(min_length=1, max_length=200)
    signature_version: int = Field(gt=0, lt=2**63, strict=True)
    signature_timestamp: datetime
    image_digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    generation: str = Field(min_length=1, max_length=100)
    checked_at: datetime
    signature_hashes: dict[str, str]

    @model_validator(mode="after")
    def validate_hashes(self) -> "ServingManifest":
        names = set(self.signature_hashes)
        if (
            len(names & {"main.cvd", "main.cld"}) != 1
            or len(names & {"daily.cvd", "daily.cld"}) != 1
            or len(names & {"bytecode.cvd", "bytecode.cld"}) > 1
            or names
            - {"main.cvd", "main.cld", "daily.cvd", "daily.cld", "bytecode.cvd", "bytecode.cld"}
            or any(
                len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)
                for digest in self.signature_hashes.values()
            )
        ):
            raise ValueError("Invalid signature hashes")
        return self


def run(host: str, port: int, manifest_json: str, content: bytes, *, probe: bool) -> dict[str, str]:
    # Imports happen inside the resource-limited child; no application settings or
    # credentials are loaded. All socket framing and response parsing belong to SDK.
    from clamdpy import ClamdNetworkSocket
    from clamdpy.exceptions import BufferTooLongError, ConnectionError

    submitted = False
    try:
        manifest = ServingManifest.model_validate_json(manifest_json)
        stamp = manifest.signature_timestamp
        now = datetime.now(UTC)
        if (
            stamp.utcoffset() != timedelta(0)
            or manifest.checked_at.utcoffset() != timedelta(0)
            or not timedelta(0) <= now - stamp <= timedelta(hours=72)
            or not timedelta(0) <= now - manifest.checked_at <= timedelta(hours=24)
        ):
            return {"error": "unavailable"}
        # Allow the engine's 45-second ZIP budget. The parent remains authoritative:
        # 58 seconds for communication plus 2 seconds for cleanup, 60 seconds total.
        client = ClamdNetworkSocket(host=host, port=port, timeout=55)
        version = client.version()
        # clamd VERSION has a timezone-less date. Deployment fixes its TZ to UTC.
        if (
            version.version != manifest.engine_version
            or version.signature != manifest.signature_version
            or version.signature_date.replace(tzinfo=UTC) != stamp
        ):
            return {"error": "unavailable"}
        outcome: Literal["clean", "infected", "unknown"] = "unknown"
        if not probe:
            if not content or len(content) > MAX_BYTES:
                return {"error": "unavailable"}
            submitted = True
            result = client.instream(BytesIO(content))
            if result.status == "OK" and result.reason is None:
                outcome = "clean"
            elif result.status == "FOUND" and isinstance(result.reason, str) and result.reason:
                reason = result.reason.lower()
                if reason.startswith("heuristics.limits") or "encrypted" in reason:
                    return {"error": "policy"}
                outcome = "infected"
            elif result.status == "ERROR":
                # A parsed terminal ERROR is definitive completion, never clean.
                return {"error": "unavailable"}
            else:
                return {"error": "uncertain"}
        return {
            "outcome": outcome,
            "digest": sha256(content).hexdigest(),
            "scanner_version": version.version,
            # Hash the exact retained UTF-8 manifest bytes, including whitespace.
            # This binds the generation, image, and complete signature hash set.
            "signature_version": (
                f"{version.signature};manifest-sha256="
                + sha256(manifest_json.encode("utf-8")).hexdigest()
            ),
        }
    except BufferTooLongError:
        return {"error": "policy" if submitted else "unavailable"}
    except ConnectionError as exc:
        if exc.errorno == errno.ECONNREFUSED:
            return {"error": "unavailable"}
        return {"error": "uncertain" if submitted else "unavailable"}
    except Exception:
        # Deliberate process boundary: never expose SDK text or interpret a lost
        # connection as engine completion. VERSION failures precede submission.
        return {"error": "uncertain" if submitted else "unavailable"}


def main() -> int:
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    content = sys.stdin.buffer.read(MAX_BYTES + 1)
    result = run(sys.argv[2], int(sys.argv[3]), sys.argv[4], content, probe=sys.argv[1] == "probe")
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
