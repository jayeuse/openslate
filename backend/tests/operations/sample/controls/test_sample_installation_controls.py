"""Packs that populate at the same time leave the installation controls to one of them."""

import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest

from operations.sample.controls.actions import plan_controls
from operations.sample.journal import append_event
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.scenario import build_dataset
from operations.sample.verification import route_coverage

ANCHOR = date(2026, 10, 2)
INSTALLATION_KEYS = {"control:update-workspace-security"}


def _plan(pack: str, *, installation: bool) -> set[str]:
    dataset = build_dataset(
        "small", 83, ANCHOR, organization=get_pack(pack), installation_controls=installation
    )
    return {action.key for action in plan_controls(dataset)}


@pytest.mark.parametrize("pack", pack_keys())
def test_a_pack_beside_another_leaves_out_only_the_installation_controls(pack: str) -> None:
    full, beside = _plan(pack, installation=True), _plan(pack, installation=False)
    removed = full - beside

    assert beside < full
    assert INSTALLATION_KEYS <= removed
    assert all(key.startswith("control:backups:") or key in INSTALLATION_KEYS for key in removed)
    assert any(key.startswith("control:backups:") for key in removed)


def test_host_acceptance_needs_the_installation_controls() -> None:
    with pytest.raises(ValueError, match="installation controls"):
        build_dataset(
            "small", 83, ANCHOR, organization=get_pack("harbor"), host_acceptance=True,
            installation_controls=False,
        )  # fmt: skip


def test_route_coverage_excuses_only_the_installation_routes_for_a_pack_beside_another(
    tmp_path: Path,
) -> None:
    covered = route_coverage.SEEDER_ROUTES - route_coverage.HOST_ACCEPTANCE_ROUTES
    covered -= route_coverage.INSTALLATION_ROUTES
    for name in ("requests.jsonl", "invitation-requests.jsonl", "verification-requests.jsonl"):
        (tmp_path / name).touch(mode=0o600)
    for method, route in sorted(covered):
        attempt = str(uuid4())
        journal = tmp_path / "requests.jsonl"
        started = {"event": "request_started", "attempt_id": attempt}
        append_event(journal, {**started, "method": method, "route_template": route})
        append_event(journal, {"event": "request_finished", "attempt_id": attempt,
                               "status_code": 200})  # fmt: skip

    _, beside = route_coverage.verify_route_coverage(tmp_path, installation_controls=False)
    _, full = route_coverage.verify_route_coverage(tmp_path)

    assert beside == []
    assert len(full) == len(route_coverage.INSTALLATION_ROUTES)
    assert json.dumps(sorted(route_coverage.INSTALLATION_ROUTES))
