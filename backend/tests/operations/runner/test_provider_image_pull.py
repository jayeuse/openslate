"""A cold runner pulls the pinned provider images in their own budget before creation."""

import subprocess
from contextlib import contextmanager

import pytest

from tests import supabase_runtime

FAILING = "supabase/realtime:v2.143.3@sha256:"
PRESENT = "axllent/mailpit:v1.27.9@sha256:"


class _Created(Exception):
    pass


CREATED = ["lock", "config --quiet", "create"]


@pytest.mark.parametrize(
    ("outcome", "expected", "after_pulls"),
    [
        # One registry refusal, then the image arrives: the stack is created.
        (["refused", "pulled"], _Created, CREATED),
        # The whole budget runs out inside a pull: no retry and no creation.
        (["timeout"], subprocess.TimeoutExpired, []),
        # The registry keeps refusing: three attempts, then the error, no creation.
        (["refused", "refused", "refused"], subprocess.CalledProcessError, []),
    ],
    ids=["transient-registry-error", "budget-exhausted", "registry-keeps-refusing"],
)
def test_images_are_pulled_in_one_budget_before_the_network_lock_and_creation(
    tmp_path, monkeypatch, outcome, expected, after_pulls
):
    clock, events, attempts = [100.0], [], []
    remaining = iter(outcome)
    monkeypatch.setattr(supabase_runtime, "monotonic", lambda: clock[0])

    def wait(seconds):
        clock[0] += seconds

    monkeypatch.setattr(supabase_runtime, "_wait", wait)

    @contextmanager
    def network_lock():
        events.append("lock")
        yield

    monkeypatch.setattr(supabase_runtime, "_network_allocation", network_lock)
    with (tmp_path / "private.log").open("w") as log:
        runtime = supabase_runtime.DisposablePostgres(tmp_path, "a" * 32, {}, log)
        monkeypatch.setattr(runtime, "_free_network_block", lambda: 1)
        monkeypatch.setattr(runtime, "_write_inputs", lambda: None)

        def docker(arguments, *, timeout, **_kwargs):
            if arguments[:2] == ["image", "inspect"]:
                if arguments[-1].startswith(PRESENT):
                    return subprocess.CompletedProcess(arguments, 0, "sha256:present")
                raise subprocess.CalledProcessError(1, ["docker", *arguments])
            assert arguments[:2] == ["pull", "--quiet"]
            events.append("pull")
            if arguments[2].startswith(FAILING):
                attempts.append(timeout)
                result = next(remaining)
                if result == "refused":
                    raise subprocess.CalledProcessError(1, ["docker", *arguments])
                if result == "timeout":
                    raise subprocess.TimeoutExpired(["docker", *arguments], timeout)
            return subprocess.CompletedProcess(arguments, 0, "")

        def compose(arguments, **_kwargs):
            events.append(" ".join(arguments))
            if arguments[0] == "create":
                raise _Created
            return subprocess.CompletedProcess(arguments, 0, "")

        monkeypatch.setattr(runtime, "_run", docker)
        monkeypatch.setattr(runtime, "_compose", compose)
        with pytest.raises(expected):
            runtime.start()

    # Of the nine distinct pinned images (Storage and its volume init share one), the
    # present one is not pulled and the seven other missing ones pull once each, all
    # before the network lock and creation.
    assert events == ["pull"] * (7 + len(outcome)) + after_pulls
    # Retries share the first deadline instead of restarting it.
    assert attempts == [300.0, 295.0, 280.0][: len(outcome)]
