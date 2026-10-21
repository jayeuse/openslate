"""One-shot optional fetch with an independent absolute deadline, including blocked DNS."""

import json
import math
import resource
import signal
import sys
from time import monotonic


def main() -> int:
    try:
        deadline = float(sys.argv[1])
        budget = min(5.0, deadline - monotonic())
        if not math.isfinite(budget) or budget <= 0:
            return 1
        # Default kernel termination does not wait for Python/GIL or a stalled DNS call.
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.setitimer(signal.ITIMER_REAL, budget)
        resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
        if sys.platform == "linux":
            resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
        from app.systems.comms.previews.fetch import fetch_metadata

        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            return 1
        request = json.loads(raw)
        if (
            not isinstance(request, dict)
            or set(request) != {"url"}
            or not isinstance(request["url"], str)
        ):
            return 1
        result = fetch_metadata(request["url"], deadline=deadline)
        if result is None or monotonic() >= deadline:
            return 1
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode())
        return 0
    except Exception:
        return 1  # No upstream URL, response, parser exception or credentials are logged.


if __name__ == "__main__":
    raise SystemExit(main())
