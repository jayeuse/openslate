"""S18 current readback, including an explicitly bound partner verification client."""

from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from pydantic import TypeAdapter, ValidationError

from app.systems.comms.files.router import CommsFile
from app.systems.comms.messages.schemas import (
    AvailableRecord,
    LiveMessage,
    MessageResponse,
    ThreadResponse,
    UnavailableRecord,
)
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.controls.comms_structure_common import check
from operations.sample.controls.files_verification import check_download
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import SamplePhaseActionError, _id

MESSAGE: TypeAdapter[Any] = TypeAdapter(MessageResponse)
REFERENCE: TypeAdapter[Any] = TypeAdapter(AvailableRecord | UnavailableRecord)
STEPS = (
    "reserve",
    "upload",
    "root",
    "create_thread",
    "unfollow",
    "follow",
    "reply",
    "replay_reply",
    "edit_thread",
    "reaction_on",
    "reaction_off",
    "reaction_again",
    "pin",
)


def message_response(response: httpx.Response, org: str, conversation: str) -> LiveMessage:
    try:
        message = MESSAGE.validate_json(response.content)
    except ValidationError as exc:
        raise SamplePhaseActionError("Invalid content message", step="message_readback") from exc
    check(
        isinstance(message, LiveMessage)
        and str(message.org_id) == org
        and str(message.conversation_id) == conversation,
        "message_context",
    )
    assert isinstance(message, LiveMessage)
    return message


def verify_content_control(
    client: SampleClient, action: PhaseAction, result: Mapping[str, Any], admin_id: str
) -> list[str]:
    issues = []
    receipts = result.get("request_evidence", [])
    expected_statuses = [201, 200, 201, 201, 200, 200, 201, 200, 200, 200, 200, 200, 200]
    if (
        tuple(row.get("step") for row in receipts) != STEPS
        or [row.get("status_code") for row in receipts] != expected_statuses
        or any(not row.get("request_id") or row.get("actor_id") != admin_id for row in receipts)
        or result.get("actor_id") != admin_id
        or result.get("organization_id") != client.organization_id
        or result.get("content_verified") is not True
    ):
        issues.append("S18 request evidence differs")
    try:
        conversation = _id(result, "conversation_id", label="conversation", step=action.key)
        root = _id(result, "root_message_id", label="message", step=action.key)
        file = CommsFile.model_validate(result["file"])
        c = f"/api/comms/conversations/{conversation}"
        current = message_response(
            client.request("GET", c + "/messages/" + root),
            str(client.organization_id),
            conversation,
        )
        check(
            current.pinned_by == UUID(admin_id)
            and any(row.id == file.id for row in current.attachments),
            "retained_content",
        )
        thread = ThreadResponse.model_validate_json(
            client.request("GET", c + "/threads/" + root).content
        )
        check(
            str(thread.id) == result["thread_id"]
            and thread.name == "Follow-up"
            and thread.resolved
            and thread.followed
            and thread.reply_count == 1,
            "retained_thread",
        )
        check(
            check_download(
                client.request("GET", c + f"/files/{file.id}/content"),
                file.model_dump(mode="json"),
                filename=str(action.values["filename"]),
                purpose="comms_attachment",
                step="retained_file",
            )
            == result["digest"],
            "retained_digest",
        )
        if action.values["organization"] == "primary":
            reference = REFERENCE.validate_json(
                client.request(
                    "GET", c + "/record-references/" + str(result["reference_id"])
                ).content
            )
            check(
                result.get("record_reference_verified") is True
                and isinstance(reference, AvailableRecord)
                and str(reference.record_id) == result["record_id"],
                "retained_record",
            )
        else:
            check(
                result.get("record_reference_verified") is False
                and result.get("record_id") is None,
                "partner_catalog_isolation",
            )
    except (ValueError, KeyError, SamplePhaseActionError):
        issues.append("S18 retained readback differs")
    return issues


def verify_content_runs(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    *,
    api_url: str,
    origin: str,
    journal: Path,
    admin_login: tuple[str, str],
) -> tuple[dict[str, int], list[str]]:
    from operations.sample.controls.comms_content import plan_content_controls

    actions = plan_content_controls(dataset)
    rows = manifest.get("control_results", [])
    if not any(
        isinstance(row, Mapping) and row.get("action_key") in {a.key for a in actions}
        for row in rows
    ):
        return {}, []
    count, issues = 0, []
    for action in actions:
        matches = [
            row for row in rows if isinstance(row, Mapping) and row.get("action_key") == action.key
        ]
        if len(matches) != 1:
            issues.append("S18 execution result is missing or duplicated")
            continue
        result = matches[0]
        if action.values["organization"] == "primary":
            current = verify_content_control(client, action, result, admin_id)
        else:
            try:
                partner_id = str(UUID(str(manifest.get("partner_organization_id"))))
            except ValueError:
                issues.append("S18 partner organization is invalid")
                continue
            if partner_id == client.organization_id or result.get("organization_id") != partner_id:
                issues.append("S18 partner binding differs")
                continue
            with SampleClient(api_url, origin, journal, partner_id) as partner:
                if partner.login(*admin_login).status_code != 200:
                    issues.append("S18 partner verification sign-in failed")
                    continue
                try:
                    current = verify_content_control(partner, action, result, admin_id)
                finally:
                    partner.request("POST", "/api/auth/logout")
        issues.extend(current)
        count += not current
    return {"comms_content_verified": count}, issues
