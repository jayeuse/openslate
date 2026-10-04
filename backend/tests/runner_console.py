"""Console behaviour shared by the disposable-stack test runners.

Runners turn SIGTERM and SIGHUP into an interrupt, so a stopped run still removes its
disposable stack.
"""

import signal


def stop_on_signals() -> None:
    """Raise KeyboardInterrupt on SIGTERM or SIGHUP so the runner's cleanup runs once."""

    def interrupt(number: int, frame: object) -> None:
        # A second signal must not interrupt the cleanup that the first one started.
        for name in ("SIGTERM", "SIGHUP"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), signal.SIG_IGN)
        raise KeyboardInterrupt(signal.Signals(number).name)

    for name in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), interrupt)
