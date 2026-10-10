"""Isolated parser process entry; imports only the parsers so each upload starts fast."""

import resource
import sys

from app.systems.platform.files.validation import MAX_BYTES, InvalidContent, inspect_content


def main() -> int:
    # Bound CPU and address space even if a third-party parser loops or expands input.
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    content = sys.stdin.buffer.read(MAX_BYTES + 1)
    try:
        validated = inspect_content("file" + sys.argv[1], content, logo=sys.argv[2] == "logo")
    except InvalidContent:
        return 1
    sys.stdout.buffer.write(validated.content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
