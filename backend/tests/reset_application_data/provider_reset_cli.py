"""Bounded private execution helpers for the destructive reset CLI acceptance."""

from __future__ import annotations

import os
import pty
import re
import select
import selectors
import stat
import subprocess
import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2]
_RESET_COMMAND = [sys.executable, "operations/reset_application_data.py"]
_TIMEOUT_SECONDS = 60
_OUTPUT_LIMIT = 64 * 1024
_STREAM_LIMIT = 24 * 1024
_READ_SIZE = 4096
_ARTIFACT_NAME = "provider-reset-cli-failure.txt"
_PROMPT = b"Enter the impact digest exactly as shown to execute:"
_REJECTION = b"An exact impact-digest confirmation is required"
_SUCCESS = b"Application data reset completed"
_SENSITIVE_ENV_MARKERS = (
    "DATABASE_URL",
    "EMAIL",
    "ISSUER",
    "KEY",
    "MANIFEST",
    "PASSWORD",
    "SECRET",
    "TOKEN",
    "URL",
)


def _as_bytes(value: str | bytes | None) -> bytes:
    if value is None:
        return b""
    return value.encode("utf-8", errors="replace") if isinstance(value, str) else value


def _redact(data: str | bytes | None, environment: dict[str, str]) -> bytes:
    output = _as_bytes(data).decode("utf-8", errors="replace")
    secrets = sorted(
        (
            value
            for name, value in environment.items()
            if value and any(marker in name.upper() for marker in _SENSITIVE_ENV_MARKERS)
        ),
        key=len,
        reverse=True,
    )
    for value in secrets:
        output = output.replace(value, "[REDACTED]")
    output = re.sub(r"(?i)(\bBearer\s+)[^\s]+", r"\1[REDACTED]", output)
    output = re.sub(r"(?i)(impact_digest=)[a-f0-9]{64}", r"\1[REDACTED]", output)
    output = re.sub(r"\b[a-f0-9]{64}\b", "[REDACTED-DIGEST]", output)
    output = re.sub(
        r"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b",
        "[REDACTED-ID]",
        output,
        flags=re.IGNORECASE,
    )
    return output.encode("utf-8", errors="replace")


def _private_artifact_path(environment: dict[str, str]) -> Path:
    raw_manifest = environment.get("OPENSLATE_TEST_DATABASE_MANIFEST", "")
    if not raw_manifest:
        raise RuntimeError("The private runner manifest is unavailable for CLI diagnostics")
    manifest = Path(raw_manifest)
    try:
        manifest_stat = manifest.lstat()
        directory_stat = manifest.parent.lstat()
    except OSError:
        raise RuntimeError(
            "The private runner manifest is unavailable for CLI diagnostics"
        ) from None
    if (
        manifest.name != "database.json"
        or not stat.S_ISREG(manifest_stat.st_mode)
        or stat.S_IMODE(manifest_stat.st_mode) & 0o077
        or not stat.S_ISDIR(directory_stat.st_mode)
        or stat.S_IMODE(directory_stat.st_mode) & 0o077
    ):
        raise RuntimeError("CLI diagnostics require the owner-only runner directory")
    owner_uid = getattr(os, "geteuid", lambda: None)()
    if owner_uid is not None and (
        manifest_stat.st_uid != owner_uid or directory_stat.st_uid != owner_uid
    ):
        raise RuntimeError("CLI diagnostics require the current runner owner")
    return manifest.parent / _ARTIFACT_NAME


def _write_failure(
    environment: dict[str, str],
    *,
    phase: str,
    status: str | int,
    stdout: str | bytes | None = None,
    stderr: str | bytes | None = None,
    terminal: str | bytes | None = None,
) -> Path:
    path = _private_artifact_path(environment)
    sections = [f"phase={phase}\nstatus={status}\n".encode()]
    for label, value in (("stdout", stdout), ("stderr", stderr), ("terminal", terminal)):
        if value is None:
            continue
        content = _redact(value, environment)
        truncated = len(content) > _STREAM_LIMIT
        content = content[:_STREAM_LIMIT]
        note = b"\n[section truncated]\n" if truncated else b""
        sections.extend((f"--- {label} ---\n".encode(), content, note, b"\n"))
    artifact = b"".join(sections)[:_OUTPUT_LIMIT]
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            offset = 0
            while offset < len(artifact):
                offset += os.write(descriptor, artifact[offset:])
        finally:
            os.close(descriptor)
    except OSError:
        raise RuntimeError("The bounded private CLI diagnostic could not be written") from None
    return path


def _run_bounded_cli(environment: dict[str, str]) -> tuple[int, str, str]:
    try:
        process = subprocess.Popen(
            _RESET_COMMAND,
            cwd=_BACKEND,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            close_fds=True,
            start_new_session=True,
        )
    except OSError:
        _write_failure(environment, phase="dry-run", status="spawn-error")
        raise RuntimeError(
            "Reset CLI dry run could not start; inspect private CLI diagnostics"
        ) from None

    assert process.stdout is not None and process.stderr is not None
    stdout, stderr = bytearray(), bytearray()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, stdout)
    selector.register(process.stderr, selectors.EVENT_READ, stderr)
    deadline = time.monotonic() + _TIMEOUT_SECONDS
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                status = process.wait(timeout=5)
                _write_failure(
                    environment,
                    phase="dry-run",
                    status=f"timeout/{status}",
                    stdout=stdout,
                    stderr=stderr,
                )
                raise RuntimeError("Reset CLI dry run timed out; inspect private CLI diagnostics")
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), _READ_SIZE)
                target = key.data
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                available = _OUTPUT_LIMIT - len(stdout) - len(stderr)
                target.extend(chunk[: max(0, available)])
                if len(chunk) > available:
                    process.kill()
                    status = process.wait(timeout=5)
                    _write_failure(
                        environment,
                        phase="dry-run-output-limit",
                        status=status,
                        stdout=stdout,
                        stderr=stderr,
                    )
                    raise RuntimeError("Reset CLI output exceeded its limit")
        try:
            status = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            status = process.wait(timeout=5)
            _write_failure(
                environment,
                phase="dry-run",
                status=f"timeout/{status}",
                stdout=stdout,
                stderr=stderr,
            )
            raise RuntimeError(
                "Reset CLI dry run timed out; inspect private CLI diagnostics"
            ) from None
        return (
            status,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )
    except OSError:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        _write_failure(
            environment, phase="dry-run-io-error", status="error", stdout=stdout, stderr=stderr
        )
        raise RuntimeError(
            "Reset CLI output capture failed; inspect private CLI diagnostics"
        ) from None
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def dry_run_digest(environment: dict[str, str]) -> str:
    status, stdout, stderr = _run_bounded_cli(environment)
    if status != 0:
        _write_failure(
            environment,
            phase="dry-run",
            status=status,
            stdout=stdout,
            stderr=stderr,
        )
        raise RuntimeError("Reset CLI dry run failed; inspect private CLI diagnostics")
    match = re.search(r"^impact_digest=([a-f0-9]{64})$", stdout, flags=re.MULTILINE)
    if match is None:
        _write_failure(
            environment,
            phase="dry-run-invalid-output",
            status=status,
            stdout=stdout,
            stderr=stderr,
        )
        raise RuntimeError("Reset CLI output was invalid; inspect private CLI diagnostics")
    return match.group(1)


def tty_reset(
    environment: dict[str, str], confirmation: str, *, expect_rejection: bool = False
) -> tuple[int, bool, bool, bool]:
    try:
        master, slave = pty.openpty()
    except OSError:
        _write_failure(environment, phase="tty-open", status="error")
        raise RuntimeError(
            "Reset CLI terminal could not start; inspect private CLI diagnostics"
        ) from None
    process: subprocess.Popen[bytes] | None = None
    output = bytearray()
    prompt_seen = False
    confirmation_sent = False
    deadline = time.monotonic() + _TIMEOUT_SECONDS
    try:
        process = subprocess.Popen(
            [*_RESET_COMMAND, "--execute"],
            cwd=_BACKEND,
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            close_fds=True,
            start_new_session=True,
        )
        os.close(slave)
        while True:
            if time.monotonic() >= deadline:
                _write_failure(environment, phase="tty", status="timeout", terminal=output)
                raise RuntimeError(
                    "Reset CLI confirmation timed out; inspect private CLI diagnostics"
                )
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, _READ_SIZE)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > _OUTPUT_LIMIT:
                    _write_failure(
                        environment, phase="tty-output-limit", status="aborted", terminal=output
                    )
                    raise RuntimeError("Reset CLI terminal output exceeded its limit")
                prompt_seen = prompt_seen or _PROMPT in output
                if prompt_seen and not confirmation_sent:
                    os.write(master, (confirmation + "\n").encode("ascii"))
                    confirmation_sent = True
            status = process.poll()
            if status is not None and not ready:
                break
        status = process.wait(timeout=5)
        rejected, succeeded = _REJECTION in output, _SUCCESS in output
        expected = (
            status != 0 and prompt_seen and rejected and not succeeded
            if expect_rejection
            else status == 0 and prompt_seen and succeeded and not rejected
        )
        if not expected:
            _write_failure(
                environment, phase="tty-unexpected-result", status=status, terminal=output
            )
        return status, prompt_seen, rejected, succeeded
    except (OSError, subprocess.TimeoutExpired):
        _write_failure(environment, phase="tty-error", status="error", terminal=output)
        raise RuntimeError(
            "Reset CLI terminal interaction failed; inspect private CLI diagnostics"
        ) from None
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        for descriptor in (master, slave):
            try:
                os.close(descriptor)
            except OSError:
                pass
