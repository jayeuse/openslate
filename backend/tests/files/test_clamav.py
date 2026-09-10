"""Scanner SDK and isolation contracts; no live daemon is contacted here."""

import errno
import json
import subprocess
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from clamdpy.exceptions import BufferTooLongError, ConnectionError, ResponseError
from clamdpy.models import ScanResult, VersionInfo

from app.systems.files import providers
from app.systems.files.clamav import ClamAVScanner
from app.systems.files.clamav_client import run


def test_configured_scanner_is_not_the_unavailable_provider(monkeypatch):
    settings = SimpleNamespace(
        files_clamav_host="127.0.0.1",
        files_clamav_port=3310,
        files_clamav_manifest_path="/nonexistent/serving-manifest.json",
    )
    monkeypatch.setattr(providers, "get_scanner_settings", lambda: settings)
    assert not isinstance(providers.get_scanner(), providers.UnavailableScanner)


def test_scanner_worker_requires_complete_scanner_configuration(monkeypatch):
    monkeypatch.setattr(
        providers,
        "get_scanner_settings",
        lambda: (_ for _ in ()).throw(providers.ConfigurationError("FILES_CLAMAV_HOST")),
    )

    with pytest.raises(providers.ConfigurationError, match="FILES_CLAMAV_HOST"):
        providers.get_scanner(require_configuration=True)


def test_scanner_worker_reports_missing_configuration_safely(monkeypatch, capsys):
    from app.systems.files import worker

    monkeypatch.setattr(worker.sys, "argv", ["scanner-worker"])
    monkeypatch.setattr(worker, "get_scanner", lambda **_: (_ for _ in ()).throw(
        providers.ConfigurationError("Invalid configuration: FILES_CLAMAV_HOST")
    ))

    assert worker.main() == 2
    assert capsys.readouterr().err == "Invalid configuration: FILES_CLAMAV_HOST\n"


@pytest.fixture
def sdk(monkeypatch, tmp_path):
    now = datetime.now(UTC).replace(microsecond=0)
    manifest = {
        "engine_version": "ClamAV 1.4.3",
        "signature_version": 27065,
        "signature_timestamp": now.isoformat(),
        "checked_at": now.isoformat(),
        "image_digest": "sha256:" + "a" * 64,
        "generation": "fixed-one",
        "signature_hashes": {"main.cvd": "b" * 64, "daily.cvd": "c" * 64},
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    client = Mock()
    client.version.return_value = VersionInfo("ClamAV 1.4.3", 27065, now.replace(tzinfo=None))
    client.instream.return_value = ScanResult("stream", None, "OK")
    monkeypatch.setattr("clamdpy.ClamdNetworkSocket", Mock(return_value=client))
    return client, path, manifest


def test_sdk_clean_binds_exact_bytes_and_version(sdk):
    client, path, _ = sdk
    result = run("127.0.0.1", 3310, path.read_text(), b"document", probe=False)
    assert result == {
        "outcome": "clean",
        "digest": sha256(b"document").hexdigest(),
        "scanner_version": "ClamAV 1.4.3",
        "signature_version": "27065;manifest-sha256=" + sha256(path.read_bytes()).hexdigest(),
    }
    assert client.instream.call_args.args[0].getvalue() == b"document"


@pytest.mark.parametrize(
    ("status", "reason", "expected"),
    [
        ("FOUND", "Eicar-Signature", {"outcome": "infected"}),
        ("FOUND", "Heuristics.Limits.Exceeded", {"error": "policy"}),
        ("FOUND", "Heuristics.Encrypted.Zip", {"error": "policy"}),
        ("ERROR", "provider private text", {"error": "unavailable"}),
        ("OK", "unexpected reason", {"error": "uncertain"}),
        ("FOUND", None, {"error": "uncertain"}),
    ],
)
def test_sdk_only_definitive_results_are_accepted(sdk, status, reason, expected):
    client, path, _ = sdk
    client.instream.return_value = ScanResult("stream", reason, status)
    result = run("127.0.0.1", 3310, path.read_text(), b"document", probe=False)
    assert all(result[k] == v for k, v in expected.items())
    assert "provider private text" not in json.dumps(result)


@pytest.mark.parametrize(
    ("exception", "expected"),
    [
        (ConnectionError("refused", errno.ECONNREFUSED), "unavailable"),
        (ConnectionError("reset", errno.ECONNRESET), "uncertain"),
        (TimeoutError(), "uncertain"),
        (ResponseError("INSTREAM", "malformed secret"), "uncertain"),
        (BufferTooLongError("size limit"), "policy"),
    ],
)
def test_sdk_failure_distinguishes_possible_execution(sdk, exception, expected):
    client, path, _ = sdk
    client.instream.side_effect = exception
    assert run("127.0.0.1", 3310, path.read_text(), b"document", probe=False) == {"error": expected}


@pytest.mark.parametrize(
    "change",
    ["stale_check", "stale_signatures", "future", "version", "hashes", "oversize", "naive"],
)
def test_bad_readiness_never_submits_bytes(sdk, change):
    client, path, manifest = sdk
    if change == "stale_check":
        manifest["checked_at"] = (datetime.now(UTC) - timedelta(hours=25)).isoformat()
    elif change == "stale_signatures":
        manifest["signature_timestamp"] = (datetime.now(UTC) - timedelta(hours=73)).isoformat()
    elif change == "future":
        manifest["checked_at"] = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
    elif change == "version":
        client.version.return_value = VersionInfo("ClamAV other", 27065, datetime.now())
    elif change == "hashes":
        manifest["signature_hashes"] = {"../main.cvd": "f" * 64}
    elif change == "naive":
        manifest["checked_at"] = datetime.now().isoformat()
    path.write_text(json.dumps(manifest))
    if change == "oversize":
        path.write_bytes(b"x" * 8193)
    assert run("127.0.0.1", 3310, path.read_text(), b"document", probe=False) == {
        "error": "unavailable"
    }
    client.instream.assert_not_called()


def test_probe_checks_version_without_scan(sdk):
    client, path, _ = sdk
    assert run("127.0.0.1", 3310, path.read_text(), b"", probe=True)["outcome"] == "unknown"
    client.version.assert_called_once()
    client.instream.assert_not_called()


def test_probe_connection_loss_is_retryable(sdk):
    client, path, _ = sdk
    client.version.side_effect = ConnectionError("lost", errno.ECONNRESET)
    assert run("127.0.0.1", 3310, path.read_text(), b"", probe=True) == {"error": "unavailable"}


@pytest.mark.parametrize(
    "content,digest",
    [(b"x", "bad"), (b"", sha256(b"").hexdigest()), (b"x" * (25 * 1024 * 1024 + 1), "bad")],
)
def test_invalid_identity_does_not_start_client(monkeypatch, content, digest):
    start = Mock()
    monkeypatch.setattr(subprocess, "Popen", start)
    with pytest.raises(providers.ProviderUnavailable):
        ClamAVScanner("127.0.0.1", 3310, "/manifest").scan(
            content, digest=digest, operation_id=uuid4()
        )
    start.assert_not_called()


@pytest.mark.parametrize("probe", [False, True])
def test_deadline_kills_and_reaps_client_with_scrubbed_environment(monkeypatch, probe, sdk):
    process = Mock(returncode=0)
    process.communicate.side_effect = [subprocess.TimeoutExpired("client", 60), (b"", None)]
    start = Mock(return_value=process)
    monkeypatch.setattr(subprocess, "Popen", start)
    scanner = ClamAVScanner("127.0.0.1", 3310, sdk[1])
    expected = providers.ProviderUnavailable if probe else providers.ScannerExecutionUncertain
    with pytest.raises(expected):
        if probe:
            scanner.probe()
        else:
            scanner.scan(b"x", digest=sha256(b"x").hexdigest(), operation_id=uuid4())
    process.kill.assert_called_once()
    assert process.communicate.call_count == 2
    assert start.call_args.kwargs["env"] == {
        "PATH": __import__("os").defpath,
        "PYTHONNOUSERSITE": "1",
        "TZ": "UTC",
        "LC_ALL": "C",
    }


@pytest.mark.parametrize(
    "output",
    [
        b"bad",
        b"x" * 2049,
        b"{}",
        b'{"error": 4}',
        b'{"error":"uncertain"}',
        b'{"outcome":"clean","digest":"wrong","scanner_version":"1","signature_version":"2"}',
    ],
)
def test_malformed_child_response_is_uncertain(monkeypatch, output, sdk):
    process = Mock(returncode=0)
    process.communicate.return_value = (output, None)
    monkeypatch.setattr(subprocess, "Popen", Mock(return_value=process))
    with pytest.raises(providers.ScannerExecutionUncertain):
        ClamAVScanner("127.0.0.1", 3310, sdk[1]).scan(
            b"x", digest=sha256(b"x").hexdigest(), operation_id=uuid4()
        )


def test_successful_child_verdict_and_manifest_snapshot(monkeypatch, sdk):
    _, path, original = sdk
    digest = sha256(b"x").hexdigest()
    process = Mock(returncode=0)
    process.communicate.return_value = (
        json.dumps(
            {
                "outcome": "clean",
                "digest": digest,
                "scanner_version": "ClamAV 1.4.3",
                "signature_version": "27065",
            }
        ).encode(),
        None,
    )
    start = Mock(return_value=process)
    monkeypatch.setattr(subprocess, "Popen", start)
    scanner = ClamAVScanner("127.0.0.1", 3310, path)
    assert scanner.scan(b"x", digest=digest, operation_id=uuid4()).outcome == "clean"
    path.write_text("{}")
    assert scanner.scan(b"x", digest=digest, operation_id=uuid4()).digest == digest
    assert all(json.loads(call.args[0][-1]) == original for call in start.call_args_list)


@pytest.mark.parametrize("failure", ["missing", "oversize", "spawn"])
def test_presubmission_local_failure_is_retryable(monkeypatch, sdk, failure):
    _, path, _ = sdk
    if failure == "missing":
        path.unlink()
    elif failure == "oversize":
        path.write_text("x" * 8193)
    else:
        monkeypatch.setattr(subprocess, "Popen", Mock(side_effect=OSError()))
    with pytest.raises(providers.ProviderUnavailable) as exc:
        ClamAVScanner("127.0.0.1", 3310, path).probe()
    assert type(exc.value) is providers.ProviderUnavailable


@pytest.mark.parametrize(
    "error,expected",
    [
        ("policy", providers.ScannerPolicyRejected),
        ("unavailable", providers.ProviderUnavailable),
    ],
)
def test_child_known_failure_preserves_exception_contract(monkeypatch, sdk, error, expected):
    process = Mock(returncode=0)
    process.communicate.return_value = (json.dumps({"error": error}).encode(), None)
    monkeypatch.setattr(subprocess, "Popen", Mock(return_value=process))
    with pytest.raises(expected) as exc:
        ClamAVScanner("127.0.0.1", 3310, sdk[1]).scan(
            b"x", digest=sha256(b"x").hexdigest(), operation_id=uuid4()
        )
    assert type(exc.value) is expected


def test_runner_applies_linux_resource_limits_and_emits_only_verdict(monkeypatch, sdk):
    from io import BytesIO, StringIO

    from app.systems.files import clamav_client

    client, path, _ = sdk
    limits = Mock()
    output = StringIO()
    monkeypatch.setattr(clamav_client.resource, "setrlimit", limits)
    monkeypatch.setattr(clamav_client.sys, "platform", "linux")
    monkeypatch.setattr(clamav_client.sys, "stdin", SimpleNamespace(buffer=BytesIO(b"document")))
    monkeypatch.setattr(clamav_client.sys, "stdout", output)
    monkeypatch.setattr(
        clamav_client.sys, "argv", ["runner", "scan", "127.0.0.1", "3310", path.read_text()]
    )
    assert clamav_client.main() == 0
    limits.assert_any_call(clamav_client.resource.RLIMIT_CPU, (30, 30))
    limits.assert_any_call(clamav_client.resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    assert json.loads(output.getvalue())["outcome"] == "clean"
    assert len(output.getvalue()) < 2048
    client.instream.assert_called_once()


def test_runner_rejects_oversize_input_without_submission(sdk):
    client, path, _ = sdk
    assert run("127.0.0.1", 3310, path.read_text(), b"x" * (25 * 1024 * 1024 + 1), probe=False) == {
        "error": "unavailable"
    }
    client.instream.assert_not_called()


def test_unconfigured_provider_probe_and_scan_fail_closed(monkeypatch):
    monkeypatch.setattr(
        providers,
        "get_scanner_settings",
        lambda: (_ for _ in ()).throw(providers.ConfigurationError("FILES_CLAMAV_HOST")),
    )
    scanner = providers.get_scanner()
    with pytest.raises(providers.ProviderUnavailable):
        scanner.probe()
    with pytest.raises(providers.ProviderUnavailable):
        scanner.scan(b"x", digest=sha256(b"x").hexdigest(), operation_id=uuid4())


def test_cleanup_stays_within_total_deadline_and_remains_uncertain(monkeypatch, sdk):
    from app.systems.files import clamav

    process = Mock(returncode=None)
    process.communicate.side_effect = [
        subprocess.TimeoutExpired("client", 57),
        subprocess.TimeoutExpired("cleanup", 2),
    ]
    monkeypatch.setattr(subprocess, "Popen", Mock(return_value=process))
    monkeypatch.setattr(clamav, "monotonic", Mock(side_effect=[100, 101, 158]), raising=False)
    with pytest.raises(providers.ScannerExecutionUncertain):
        ClamAVScanner("127.0.0.1", 3310, sdk[1]).scan(
            b"x", digest=sha256(b"x").hexdigest(), operation_id=uuid4()
        )
    assert [call.kwargs["timeout"] for call in process.communicate.call_args_list] == [57, 2]
    process.kill.assert_called_once()


def test_manifest_reference_changes_with_immutable_generation(sdk):
    _, path, manifest = sdk
    first = run("127.0.0.1", 3310, path.read_text(), b"document", probe=False)
    manifest["generation"] = "replacement-two"
    raw = json.dumps(manifest)
    second = run("127.0.0.1", 3310, raw, b"document", probe=False)
    assert second["signature_version"] == (
        "27065;manifest-sha256=" + sha256(raw.encode("utf-8")).hexdigest()
    )
    assert first["signature_version"] != second["signature_version"]
    assert len(second["signature_version"]) <= 200
