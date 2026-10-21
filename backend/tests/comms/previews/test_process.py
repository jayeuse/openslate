"""The production child boundary is time-bounded and credential/URL-log independent."""

import json
import os
import signal
import subprocess
import time

import pytest

URL = "https://preview.example.com/private?token=synthetic-canary"
DATA = {"url": URL, "title": "Owned title", "description": "", "site_name": ""}


def test_child_uses_stdin_minimal_environment_and_one_absolute_five_second_deadline(monkeypatch):
    from app.systems.comms.previews import process

    calls = []
    monkeypatch.setattr(process, "clock", lambda: 100.0)
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9999")
    monkeypatch.setenv("PREVIEW_TEST_PRIVATE_VALUE", "not-for-child")

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, json.dumps(DATA).encode())

    monkeypatch.setattr(process.subprocess, "run", run)
    assert process.fetch_bounded(URL) == DATA
    assert len(calls) == 1
    command, options = calls[0]
    assert URL not in repr(command) and float(command[-1]) == 105.0
    assert json.loads(options["input"])["url"] == URL
    assert 0 < options["timeout"] <= 5
    assert options["env"] == {"PATH": os.defpath, "PYTHONNOUSERSITE": "1"}
    assert options["stderr"] == subprocess.DEVNULL and options["stdout"] == subprocess.PIPE
    assert not options.get("shell", False)


@pytest.mark.parametrize(
    "problem",
    [
        "timeout",
        "failed",
        "invalid-json",
        "extra-key",
        "wrong-url",
        "long-title",
        "html-title",
        "large-output",
    ],
)
def test_failed_or_untrusted_child_output_is_not_published_or_logged(monkeypatch, caplog, problem):
    from app.systems.comms.previews import process

    def run(command, **_kwargs):
        if problem == "timeout":
            raise subprocess.TimeoutExpired(command, 5)
        data = dict(DATA)
        if problem == "extra-key":
            data["image"] = "http://127.0.0.1/private"
        elif problem == "wrong-url":
            data["url"] = "https://other.example.com/"
        elif problem == "long-title":
            data["title"] = "x" * 257
        elif problem == "html-title":
            data["title"] = "<script>not metadata</script>"
        content = (
            b"not-json"
            if problem == "invalid-json"
            else b"x" * 32769
            if problem == "large-output"
            else json.dumps(data).encode()
        )
        return subprocess.CompletedProcess(command, 1 if problem == "failed" else 0, content)

    monkeypatch.setattr(process.subprocess, "run", run)
    with caplog.at_level("DEBUG"):
        assert process.fetch_bounded(URL) is None
    assert "synthetic-canary" not in caplog.text and "Owned title" not in caplog.text


def test_blocked_dns_child_is_terminated_by_its_own_deadline_and_reaped(monkeypatch):
    from app.systems.comms.previews import process

    monkeypatch.setattr(process, "CHILD_MODULE", "tests.comms.previews.blocked_child")
    run = process.subprocess.run
    outcomes = []

    def observed(*args, **kwargs):
        # Isolate the independent child alarm from the equally timed parent watchdog.
        # The production<=5s parent timeout is asserted separately above; the child argv
        # deadline is unchanged, so a missing child alarm still fails this proof.
        kwargs["timeout"] += 1
        result = run(*args, **kwargs)
        outcomes.append(result.returncode)
        return result

    monkeypatch.setattr(process.subprocess, "run", observed)
    started = time.monotonic()
    assert process.fetch_bounded(URL) is None
    assert outcomes == [-signal.SIGALRM]
    assert (
        time.monotonic() - started < 6
    )  # Five-second work deadline plus process-reaping overhead.
