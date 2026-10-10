"""One-shot parser isolation; no provider access and no durable filesystem state."""

import os
import subprocess
import sys
from pathlib import PurePosixPath

from app.systems.platform.files.access import error
from app.systems.platform.files.validation import (
    MAX_BYTES,
    MIME,
    ValidatedContent,
    invalid,
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
                "app.systems.platform.files.validation_child",
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

