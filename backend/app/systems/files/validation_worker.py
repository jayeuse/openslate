"""One-shot parser isolation; no provider access and no durable filesystem state."""

import os
import resource
import subprocess
import sys
from pathlib import PurePosixPath

from app.systems.files.access import error
from app.systems.files.validation import (
    MAX_BYTES,
    MIME,
    ValidatedContent,
    invalid,
    validate_content,
)


def validate_bounded(filename: str, content: bytes, *, logo: bool = False) -> ValidatedContent:
    extension = PurePosixPath(filename).suffix.lower()
    if extension not in MIME:
        raise invalid()
    try:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "app.systems.files.validation_worker",
                extension,
                "logo" if logo else "document",
            ],
            input=content,
            env={"PATH": os.defpath, "PYTHONNOUSERSITE": "1"},
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=60,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise error(
            "file_validation_unavailable", "File could not be inspected in time", 503
        ) from exc
    if result.returncode != 0 or len(result.stdout) > MAX_BYTES:
        raise invalid()
    return ValidatedContent(result.stdout, MIME[extension])


def main() -> int:
    # Bound CPU and address space even if a third-party parser loops or expands input.
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    content = sys.stdin.buffer.read(MAX_BYTES + 1)
    validated = validate_content("file" + sys.argv[1], content, logo=sys.argv[2] == "logo")
    sys.stdout.buffer.write(validated.content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
