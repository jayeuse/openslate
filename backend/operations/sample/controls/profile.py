"""Owned self-profile API round trip; never replace an authored original avatar."""

from collections.abc import Mapping
from io import BytesIO
from typing import Any

import httpx
from PIL import Image, UnidentifiedImageError
from pydantic import ValidationError

from app.systems.access.users.schemas import (
    AuthMeResponse,
    PersonCardPublicResponse,
    PersonCardResponse,
    PersonProfilePublicResponse,
    PersonProfileResponse,
    UserPreferencesResponse,
)
from app.systems.platform.files.schemas import FileResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.controls.account import plan_account_controls
from operations.sample.dummy_files import dummy_file
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _request_id,
)
from operations.sample.phases.plan import plan_phases

PROFILE_FIELDS = ("display_name", "job_title", "phone", "bio", "avatar_file_id")


def plan_profile_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    from operations.sample.controls.mfa import plan_mfa_controls

    excluded = {
        key
        for action in (
            *plan_phases(dataset),
            *plan_account_controls(dataset),
            *plan_mfa_controls(dataset),
        )
        for key in (action.actor_key, action.target_key)
    }
    person = next(
        (
            person
            for person in dataset.organization.actors.people
            if person.role in {"member", "guest"}
            and person.status == "active"
            and person.key not in excluded
        ),
        None,
    )
    if person is None:
        raise ValueError(
            "Profile controls require an active non-admin outside other identity targets"
        )
    return (
        PhaseAction(
            key="control:account-profile",
            phase="admin",
            kind="account_controls",
            actor_key=person.key,
            target_key=person.key,
            values={"operation": "self_profile"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "original_profile_restored": True,
                "original_preferences_restored": True,
                "temporary_avatar_purged": True,
            },
        ),
    )


def _require(condition: bool, step: str) -> None:
    if not condition:
        raise SamplePhaseActionError("Profile control response or ownership differs", step=step)


def execute_profile_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    _require(action in plan_profile_controls(dataset), "profile_plan")
    actor = context.user_ids.get(action.actor_key)
    admin = context.user_ids.get("admin")
    _require(
        isinstance(actor, str)
        and isinstance(admin, str)
        and actor != admin
        and sum(value == actor for value in context.user_ids.values()) == 1
        and action.actor_key in context.clients
        and "admin" in context.clients,
        "profile_setup",
    )
    actor_id = _id(context.user_ids, action.actor_key, label="profile actor", step="profile_setup")
    admin_id = _id(context.user_ids, "admin", label="profile administrator", step="profile_setup")
    person = next(
        person for person in dataset.organization.actors.people if person.key == action.actor_key
    )
    evidence: list[dict[str, object]] = []
    reads: list[dict[str, object]] = []

    def request(
        step: str,
        method: str,
        path: str,
        *,
        expected: int = 200,
        body: Mapping[str, Any] | None = None,
        content: bytes | None = None,
        key: str | None = None,
    ) -> httpx.Response:
        key = key or action.actor_key
        if on_substep is not None:
            on_substep(step)
        response = context.clients[key].request(
            method,
            path,
            json_body=body,
            content=content,
            headers={"Content-Type": "application/octet-stream"} if content is not None else None,
        )
        request_id = _request_id(response)
        _require(response.status_code == expected and request_id is not None, step)
        receipt = {
            "step": step,
            "method": method,
            "path": path,
            "status_code": response.status_code,
            "expected_status": expected,
            "request_id": request_id,
            "actor_key": key,
            "actor_id": context.user_ids[key],
        }
        (reads if method == "GET" else evidence).append(receipt)
        return response

    def self_read(response: httpx.Response, step: str) -> AuthMeResponse:
        try:
            body = response.json()
            _require(isinstance(body, dict) and all(key in body for key in PROFILE_FIELDS), step)
            parsed = AuthMeResponse.model_validate_json(response.content, strict=True)
        except (ValidationError, ValueError):
            raise SamplePhaseActionError(
                "Complete private self read is invalid", step=step
            ) from None
        _require(
            str(parsed.id) == actor_id
            and parsed.role is not None and parsed.role.value == person.role
            and parsed.status.value == "active"
            and not parsed.is_deleted,
            step,
        )
        return parsed

    def preferences(response: httpx.Response, step: str) -> UserPreferencesResponse:
        try:
            parsed = UserPreferencesResponse.model_validate_json(response.content, strict=True)
        except ValidationError:
            raise SamplePhaseActionError(
                "Profile preferences response is invalid", step=step
            ) from None
        _require(str(parsed.user_id) == actor_id, step)
        return parsed

    def file_read(
        response: httpx.Response, state: str, identifier: str | None = None
    ) -> FileResponse:
        try:
            parsed = FileResponse.model_validate_json(response.content, strict=True)
        except ValidationError:
            raise SamplePhaseActionError(
                "Profile file response is invalid", step="profile_file"
            ) from None
        _require(
            parsed.purpose.value == "user_avatar"
            and str(parsed.creator_id) == actor_id
            and parsed.record_id is None
            and parsed.department_id is None
            and parsed.board_id is None
            and parsed.filename == "sample-avatar.png"
            and parsed.state.value == state
            and parsed.is_deleted == (state == "purged")
            and (identifier is None or str(parsed.id) == identifier),
            "profile_file",
        )
        return parsed

    before = self_read(request("profile_before", "GET", "/api/auth/me"), "profile_before")
    _require(before.avatar_file_id is None, "profile_original_avatar")
    prefs_path = f"/api/users/{actor_id}/preferences"
    prefs_before = preferences(
        request("preferences_before", "GET", prefs_path), "preferences_before"
    )
    original = before.model_dump(mode="json", include=set(PROFILE_FIELDS))
    temporary = {
        "display_name": "Sample profile round trip"
        if before.display_name != "Sample profile round trip"
        else "Alternate sample profile round trip",
        "job_title": "Profile control",
        "phone": "+1 sample",
        "bio": "Owned temporary profile proof",
    }
    self_read(
        request("profile_text", "PATCH", "/api/auth/me/profile", body=temporary), "profile_text"
    )
    text_read = self_read(request("profile_text_read", "GET", "/api/auth/me"), "profile_text_read")
    _require(
        all(getattr(text_read, key) == value for key, value in temporary.items()),
        "profile_text_read",
    )
    # Change only always-present stored keys, so restoring a legacy row does not
    # materialize optional regional defaults or silently change its JSON shape.
    temporary_theme = "light" if prefs_before.theme != "light" else "dark"
    temporary_motion = "reduce" if prefs_before.appearance.motion == "system" else "system"
    temporary_prefs = {
        "theme": temporary_theme,
        "appearance": {"motion": temporary_motion},
    }
    preferences(
        request("preferences_change", "PATCH", prefs_path, body=temporary_prefs),
        "preferences_change",
    )
    prefs_changed = preferences(
        request("preferences_changed_read", "GET", prefs_path), "preferences_changed_read"
    )
    _require(
        prefs_changed.theme == temporary_theme
        and prefs_changed.appearance.motion == temporary_motion,
        "preferences_changed_read",
    )
    card_response = request("visible_other_card", "GET", f"/api/users/{admin_id}/card")
    try:
        card = card_response.json()
        if person.role == "guest":
            _require(set(card) == {"display_name", "job_title", "avatar_url"}, "visible_other_card")
            PersonCardPublicResponse.model_validate_json(card_response.content, strict=True)
        else:
            _require(
                set(card) == {"display_name", "job_title", "avatar_url", "email", "phone", "bio"},
                "visible_other_card",
            )
            PersonCardResponse.model_validate_json(card_response.content, strict=True)
    except (ValidationError, ValueError):
        raise SamplePhaseActionError(
            "Person card response is invalid", step="visible_other_card"
        ) from None
    profile_response = request("visible_other_profile", "GET", f"/api/users/{admin_id}/profile")
    try:
        if person.role == "guest":
            PersonProfilePublicResponse.model_validate_json(profile_response.content, strict=True)
            _require(
                set(profile_response.json()) == {"display_name", "job_title", "avatar_url"},
                "visible_other_profile",
            )
        else:
            PersonProfileResponse.model_validate_json(profile_response.content, strict=True)
            _require(
                set(profile_response.json())
                == {"display_name", "job_title", "avatar_url", "phone", "bio", "role", "groups"},
                "visible_other_profile",
            )
    except (ValidationError, ValueError):
        raise SamplePhaseActionError(
            "Profile response is invalid", step="visible_other_profile"
        ) from None
    content = dummy_file("sample-avatar.png")
    reserved = file_read(
        request(
            "avatar_reserve",
            "POST",
            "/api/files",
            expected=201,
            body={
                "purpose": "user_avatar",
                "filename": "sample-avatar.png",
                "expected_size": len(content),
            },
        ),
        "awaiting_upload",
    )
    file_id = str(reserved.id)
    file_path = f"/api/files/{file_id}"
    file_read(
        request("avatar_upload", "PUT", f"{file_path}/content", content=content), "ready", file_id
    )
    ready = file_read(request("avatar_ready_read", "GET", file_path), "ready", file_id)
    _require(
        ready.media_type == "image/png"
        and ready.actual_size is not None
        and 0 < ready.actual_size <= 2097152,
        "avatar_ready_read",
    )
    self_read(
        request("avatar_bind", "PATCH", "/api/auth/me/profile", body={"avatar_file_id": file_id}),
        "avatar_bind",
    )
    bound = self_read(request("avatar_bound_read", "GET", "/api/auth/me"), "avatar_bound_read")
    _require(str(bound.avatar_file_id) == file_id, "avatar_bound_read")
    own_bytes: bytes | None = None
    for step, key in (("own_avatar_read", action.actor_key), ("shared_avatar_read", "admin")):
        response = request(step, "GET", f"/api/users/{actor_id}/avatar", key=key)
        _require(
            response.headers.get("content-type") == ready.media_type
            and "no-store" in response.headers.get("cache-control", "")
            and response.headers.get("x-content-type-options") == "nosniff"
            and len(response.content) == ready.actual_size,
            step,
        )
        try:
            with Image.open(BytesIO(response.content)) as image:
                image.load()
                # The sample source is independently authored as exactly one white pixel.
                _require(
                    image.format == "PNG"
                    and image.size == (1, 1)
                    and image.convert("RGBA").getpixel((0, 0)) == (255, 255, 255, 255),
                    step,
                )
        except (UnidentifiedImageError, OSError, ValueError):
            raise SamplePhaseActionError(
                "Avatar bytes differ from the owned sample image", step=step
            ) from None
        if own_bytes is None:
            own_bytes = response.content
        else:
            _require(response.content == own_bytes, step)
    self_read(
        request("avatar_clear", "PATCH", "/api/auth/me/profile", body={"avatar_file_id": None}),
        "avatar_clear",
    )
    self_read(
        request(
            "profile_restore",
            "PATCH",
            "/api/auth/me/profile",
            body={key: original[key] for key in temporary},
        ),
        "profile_restore",
    )
    preferences(
        request(
            "preferences_restore",
            "PATCH",
            prefs_path,
            body={
                "theme": prefs_before.theme,
                "appearance": {"motion": prefs_before.appearance.motion},
            },
        ),
        "preferences_restore",
    )
    after = self_read(request("profile_final", "GET", "/api/auth/me"), "profile_final")
    prefs_after = preferences(request("preferences_final", "GET", prefs_path), "preferences_final")
    final_file = file_read(request("avatar_final_file", "GET", file_path), "purged", file_id)
    request("avatar_final_absence", "GET", f"/api/users/{actor_id}/avatar", expected=404)
    _require(
        after.model_dump(mode="json", include=set(PROFILE_FIELDS)) == original
        and prefs_after == prefs_before,
        "profile_restoration",
    )
    return {
        "action_key": action.key,
        "kind": action.kind,
        "actor_key": action.actor_key,
        "target_key": action.target_key,
        "actor_id": actor_id,
        "status": "complete",
        "original_username": before.username,
        **action.expected_end_state,
        "profile_before": original,
        "profile_after": after.model_dump(mode="json", include=set(PROFILE_FIELDS)),
        "self_final": after.model_dump(mode="json"),
        "preferences_before": prefs_before.model_dump(mode="json"),
        "preferences_after": prefs_after.model_dump(mode="json"),
        "file_id": file_id,
        "file_final": final_file.model_dump(mode="json"),
        "request_evidence": evidence,
        "read_evidence": reads,
        "mappings": [],
    }
