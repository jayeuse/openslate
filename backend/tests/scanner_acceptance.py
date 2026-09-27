"""Real API → private Storage → scanner → protected download release journey."""

import time
from io import BytesIO
from typing import TYPE_CHECKING

import httpx
from pypdf import PdfWriter

from tests.scanner_recovery import API, _guard, _headers

if TYPE_CHECKING:
    from tests.scanner_runtime import DisposableScanner


def verify_scanned_downloads(
    scanner: "DisposableScanner",
    application_env: dict[str, str],
    identities: dict[str, dict[str, str]],
) -> None:
    """Use only the release runner's owned identities, providers and worker."""
    _guard(scanner, application_env, identities["admin"])
    pdf = PdfWriter()
    pdf.add_blank_page(width=72, height=72)
    clean = BytesIO()
    pdf.write(clean)
    # Harmless, standardized antivirus test signature embedded in a valid PDF.
    pdf.add_attachment(
        "eicar.com", b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
    )
    infected = BytesIO()
    pdf.write(infected)
    scanner._run(["stop", "--time", "5", scanner.worker], timeout=15)
    with httpx.Client(base_url=API, timeout=30, trust_env=False) as api:
        api.headers.update(_headers(application_env, identities["admin"]))
        files = []
        for filename, content, expected in (
            ("clean.pdf", clean.getvalue(), "ready"),
            ("infected.pdf", infected.getvalue(), "rejected"),
        ):
            reserved = api.post(
                "/api/files",
                json={
                    "purpose": "library_document",
                    "filename": filename,
                    "expected_size": len(content),
                },
            )
            if reserved.status_code != 201:
                raise RuntimeError("Scanned download reservation failed")
            identity = reserved.json()["id"]
            path = f"/api/files/{identity}/content"
            uploaded = api.put(
                path, content=content, headers={"Content-Type": "application/octet-stream"}
            )
            if uploaded.status_code != 200 or uploaded.json()["state"] != "pending_scan":
                raise RuntimeError("Scanned download upload did not enter quarantine")
            denied = api.get(path)
            if denied.status_code != 409 or denied.json()["detail"]["code"] != "file_not_ready":
                raise RuntimeError("Unscanned download was not denied")
            files.append((identity, content, expected))
        scanner._run(["start", scanner.worker], timeout=15)
        for identity, content, expected in files:
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                response = api.get(f"/api/files/{identity}")
                if response.status_code != 200:
                    raise RuntimeError("Scan status lookup failed")
                state = response.json()["state"]
                if state == expected:
                    break
                if state != "pending_scan":
                    raise RuntimeError("Scanner returned the wrong terminal state")
                time.sleep(0.2)
            else:
                raise RuntimeError("Scanned file did not reach its expected state")
            downloaded = api.get(f"/api/files/{identity}/content")
            if expected == "ready":
                if downloaded.status_code != 200 or downloaded.content != content:
                    raise RuntimeError("Clean protected download bytes differ from upload")
                if downloaded.headers.get("cache-control") != "no-store":
                    raise RuntimeError("Protected download is cacheable")
            elif (
                response.json()["failure_code"] != "scan_infected" or downloaded.status_code != 409
            ):
                raise RuntimeError("Infected content was not rejected and withheld")
        api.headers.update(_headers(application_env, identities["member"]))
        if api.get(f"/api/files/{files[0][0]}/content").status_code != 403:
            raise RuntimeError("Member bypassed library download authorization")
        api.headers.pop("Authorization")
        if api.get(f"/api/files/{files[0][0]}/content").status_code != 401:
            raise RuntimeError("Anonymous client downloaded private file bytes")
    scanner.observations["scanned_downloads"] = {
        "pending_download_denied": True,
        "clean_bytes_match": True,
        "infected_download_denied": True,
        "member_download_denied": True,
        "anonymous_download_denied": True,
    }
