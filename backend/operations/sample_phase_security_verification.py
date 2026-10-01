"""Read-only security-event evidence for the planned one-session revocation."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from app.systems.manage.audit.schemas import SecurityEventResponse
from operations.sample_client import SampleClient, SampleClientError
from operations.sample_phase_verification_plan import _Step, _uuid
from operations.sample_verification import SampleVerificationError, list_all_rows


def _verify_session_security_event(
    client: SampleClient,
    rule: _Step,
    evidence: Mapping[str, Any],
    session_id: str,
    admin_id: str,
    seen: set[str],
    counts: dict[str, int],
    issues: list[str],
) -> None:
    request_id = _uuid(evidence.get("request_id"))
    actor_id, subject_id = _uuid(admin_id), _uuid(rule.security_subject_id)
    if request_id is None or actor_id is None or subject_id is None:
        issues.append("planned session security event attribution is missing")
        return
    try:
        # This endpoint has no request-ID filter; correlate locally after full pagination.
        rows = list_all_rows(client, "/api/security-events")
    except (SampleVerificationError, SampleClientError):
        issues.append("phase session security event readback failed")
        return
    matches = [row for row in rows if _uuid(row.get("request_id")) == request_id]
    if len(matches) != 1:
        issues.append("phase session request has no unique security event")
        return
    try:
        event = SecurityEventResponse.model_validate(matches[0])
    except ValidationError:
        issues.append("phase session security event is malformed")
        return
    event_id = str(event.id)
    if event_id in seen or sum(_uuid(row.get("id")) == event_id for row in rows) != 1:
        issues.append("phase session security event identity is reused")
        return
    seen.add(event_id)
    if (
        event.event_type != rule.security_event
        or event.source != "users.sessions"
        or event.outcome != "success"
        or event.labels.get("scope") != "one"
        or str(event.actor_id) != actor_id
        or str(event.subject_id) != subject_id
        or str(event.request_id) != request_id
        or event.request_method != rule.method
        or event.request_path != f"{rule.path}{session_id}"
    ):
        issues.append("phase session security event differs from its planned request")
        return
    counts["phase_security_events"] += 1
