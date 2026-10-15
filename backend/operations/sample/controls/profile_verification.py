"""Request-bound profile round-trip evidence and current administrator card readback."""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from app.systems.access.users.schemas import (
    AuthMeResponse,
    SelfProfileUpdate,
    UserPreferencesResponse,
)
from app.systems.platform.files.schemas import FileResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.profile import PROFILE_FIELDS, plan_profile_controls
from operations.sample.phases.actions import SamplePhaseActionError, _read_json


def verify_profile_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    counts = {"profile_control_actions": 0, "profile_control_requests": 0}
    action = plan_profile_controls(dataset)[0]
    rows = manifest.get("control_results")
    results = (
        [row for row in rows if isinstance(row, Mapping) and row.get("action_key") == action.key]
        if isinstance(rows, list)
        else []
    )
    if len(results) != 1:
        return counts, ["Profile control evidence is missing or duplicated"]
    result = results[0]
    actors = manifest.get("actor_ids")
    actor_id = actors.get(action.actor_key) if isinstance(actors, Mapping) else None
    try:
        if (
            not isinstance(actor_id, str)
            or str(UUID(actor_id)) != actor_id
            or actor_id == admin_id
            or result.get("actor_id") != actor_id
            or result.get("actor_key") != action.actor_key
            or result.get("target_key") != action.target_key
            or result.get("status") != "complete"
        ):
            raise ValueError
        before, after = result["profile_before"], result["profile_after"]
        if (
            not isinstance(before, dict)
            or set(before) != set(PROFILE_FIELDS)
            or before != after
            or before["avatar_file_id"] is not None
        ):
            raise ValueError
        SelfProfileUpdate.model_validate(before)
        username = result["original_username"]
        if not isinstance(username, str) or not username:
            raise ValueError
        self_final = result["self_final"]
        if not isinstance(self_final, Mapping) or not set(PROFILE_FIELDS) <= self_final.keys():
            raise ValueError
        restored_self = AuthMeResponse.model_validate(self_final)
        person = next(
            person
            for person in dataset.organization.actors.people
            if person.key == action.actor_key
        )
        if (
            str(restored_self.id) != actor_id
            or restored_self.username != username
            or restored_self.role is None or restored_self.role.value != person.role
            or restored_self.status.value != "active"
            or restored_self.is_deleted
            or restored_self.model_dump(mode="json", include=set(PROFILE_FIELDS)) != before
        ):
            raise ValueError
        prefs_before = UserPreferencesResponse.model_validate(result["preferences_before"])
        prefs_after = UserPreferencesResponse.model_validate(result["preferences_after"])
        if prefs_before != prefs_after or str(prefs_before.user_id) != actor_id:
            raise ValueError
        file = FileResponse.model_validate(result["file_final"])
        file_id = result["file_id"]
        if (
            str(file.id) != file_id
            or file.purpose.value != "user_avatar"
            or str(file.creator_id) != actor_id
            or file.state.value != "purged"
            or not file.is_deleted
        ):
            raise ValueError
        profile_path, prefs_path, file_path = (
            "/api/auth/me/profile",
            f"/api/users/{actor_id}/preferences",
            f"/api/files/{file_id}",
        )
        writes = {
            "profile_text": ("PATCH", profile_path, 200),
            "preferences_change": ("PATCH", prefs_path, 200),
            "avatar_reserve": ("POST", "/api/files", 201),
            "avatar_upload": ("PUT", f"{file_path}/content", 200),
            "avatar_bind": ("PATCH", profile_path, 200),
            "avatar_clear": ("PATCH", profile_path, 200),
            "profile_restore": ("PATCH", profile_path, 200),
            "preferences_restore": ("PATCH", prefs_path, 200),
        }
        reads = {
            "profile_before": ("/api/auth/me", 200),
            "preferences_before": (prefs_path, 200),
            "profile_text_read": ("/api/auth/me", 200),
            "preferences_changed_read": (prefs_path, 200),
            "visible_other_card": (f"/api/users/{admin_id}/card", 200),
            "avatar_ready_read": (file_path, 200),
            "avatar_bound_read": ("/api/auth/me", 200),
            "own_avatar_read": (f"/api/users/{actor_id}/avatar", 200),
            "shared_avatar_read": (f"/api/users/{actor_id}/avatar", 200),
            "profile_final": ("/api/auth/me", 200),
            "preferences_final": (prefs_path, 200),
            "avatar_final_file": (file_path, 200),
            "avatar_final_absence": (f"/api/users/{actor_id}/avatar", 404),
        }
        identifiers: set[str] = set()
        for collection, contract in (("request_evidence", writes), ("read_evidence", reads)):
            receipts = result[collection]
            if not isinstance(receipts, list) or [
                row.get("step") for row in receipts if isinstance(row, Mapping)
            ] != list(contract):
                raise ValueError
            for row in receipts:
                step = row["step"]
                method, path, status = (
                    contract[step] if collection == "request_evidence" else ("GET", *contract[step])
                )
                request_id = str(UUID(row["request_id"]))
                key = "admin" if step == "shared_avatar_read" else action.actor_key
                if (
                    request_id != row["request_id"]
                    or request_id in identifiers
                    or (row["method"], row["path"], row["status_code"], row["expected_status"])
                    != (method, path, status, status)
                    or row["actor_key"] != key
                    or row["actor_id"] != (admin_id if key == "admin" else actor_id)
                ):
                    raise ValueError
                identifiers.add(request_id)
        # This current read is independent of mutation responses and retained self receipts.
        response = admin.request("GET", f"/api/users/{actor_id}/card")
        card = _read_json(response, step="verify_profile_card")
        if (
            response.status_code != 200
            or card.get("display_name") != (before["display_name"] or username)
            or any(card.get(key) != before[key] for key in ("job_title", "phone", "bio"))
            or card.get("avatar_url") is not None
        ):
            raise ValueError
    except (
        KeyError,
        TypeError,
        ValueError,
        ValidationError,
        SampleClientError,
        SamplePhaseActionError,
    ):
        return counts, [
            "Profile request attribution, restoration or current card readback is invalid"
        ]
    counts["profile_control_actions"], counts["profile_control_requests"] = 1, len(identifiers)
    return counts, []
