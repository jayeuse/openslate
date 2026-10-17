"""Pure expected-route rules for lifecycle phase verification."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from operations.sample.packs.phase_types import PhaseAction

_OPENVIEW = {
    "view": ("views", "saved_views"),
    "dashboard": ("dashboards", "dashboards"),
    "report": ("reports", "reports"),
}


@dataclass(frozen=True, slots=True)
class _Step:
    method: str
    path: str
    status: int
    entity: str | None = None
    entity_id: str | None = None
    action: str | None = None
    audit_rows: int = 0
    related: tuple[str, ...] = ()
    actor_key: str | None = None
    dynamic_session: bool = False
    security_event: str | None = None
    security_subject_id: str | None = None


def _uuid(value: object) -> str | None:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError):
        return None


def _mappings(
    manifest: Mapping[str, Any],
    results: Sequence[Mapping[str, Any]],
    issues: list[str],
) -> dict[str, dict[str, str]]:
    output: dict[str, dict[str, str]] = {}
    raw = manifest.get("mappings", {})
    if isinstance(raw, Mapping):
        for kind, rows in raw.items():
            if not isinstance(kind, str) or not isinstance(rows, Mapping):
                issues.append("manifest mapping index is invalid")
                continue
            output[kind] = {}
            for key, value in rows.items():
                normalized = _uuid(value)
                if not isinstance(key, str) or normalized is None:
                    issues.append("manifest mapping contains an invalid server ID")
                    continue
                output[kind][key] = normalized
    else:
        issues.append("manifest mapping index is invalid")

    for result in results:
        rows = result.get("mappings")
        if not isinstance(rows, list):
            issues.append("phase result mapping list is missing or invalid")
            continue
        for item in rows:
            if not isinstance(item, Mapping):
                issues.append("phase result mapping row is invalid")
                continue
            kind, key, value = item.get("kind"), item.get("logical_id"), item.get("server_id")
            normalized = _uuid(value)
            if not isinstance(kind, str) or not isinstance(key, str) or normalized is None:
                issues.append("phase result mapping row is invalid")
                continue
            if output.get(kind, {}).get(key) != normalized:
                issues.append("phase result mapping differs from the manifest")
    return output


def _mapping(mappings: Mapping[str, Mapping[str, str]], kind: str, key: str) -> str | None:
    value = mappings.get(kind, {}).get(key)
    return _uuid(value)


def _person_id(
    manifest: Mapping[str, Any], mappings: Mapping[str, Mapping[str, str]], key: str
) -> str | None:
    user_id = _mapping(mappings, "user", key)
    if user_id is not None:
        return user_id
    people = manifest.get("people")
    person = people.get(key) if isinstance(people, Mapping) else None
    return _uuid(person.get("user_id")) if isinstance(person, Mapping) else None


def _actor_id(manifest: Mapping[str, Any], admin_id: str, key: str) -> str | None:
    if key == "admin":
        return _uuid(admin_id)
    actor_ids = manifest.get("actor_ids")
    if not isinstance(actor_ids, Mapping):
        return None
    return _uuid(actor_ids.get(key))


def _step(
    method: str,
    path: str,
    status: int,
    entity: str | None = None,
    entity_id: str | None = None,
    action: str | None = None,
    audit_rows: int = 0,
    related: tuple[str, ...] = (),
    actor_key: str | None = None,
    dynamic_session: bool = False,
    security_event: str | None = None,
    security_subject_id: str | None = None,
) -> _Step:
    return _Step(
        method,
        path,
        status,
        entity,
        entity_id,
        action,
        audit_rows,
        related,
        actor_key,
        dynamic_session,
        security_event,
        security_subject_id,
    )


def _rules(
    action: PhaseAction,
    manifest: Mapping[str, Any],
    mappings: Mapping[str, Mapping[str, str]],
) -> dict[str, _Step]:
    user_id = _person_id(manifest, mappings, action.target_key)
    user_path = f"/api/users/{user_id or ''}"
    kind = action.kind
    if kind in {
        "promote_user",
        "demote_user",
        "refuse_role_change",
        "disable_user",
        "restore_disabled_user",
    }:
        refusal = kind == "refuse_role_change"
        # A role lives on the membership (S04): its audit row is the membership's.
        role_change = kind in {"promote_user", "demote_user"}
        related = (
            ("groups", "group_members")
            if kind == "promote_user"
            else ("identity_sessions",)
            if kind == "disable_user"
            else ()
        )
        return {
            "update_user": _step(
                "PATCH",
                user_path,
                action.expected_status,
                None if refusal else "memberships" if role_change else "users",
                None if refusal or role_change else user_id,
                None if refusal else "update",
                0 if refusal else 1,
                related,
            )
        }

    if kind in {"remove_group_member", "add_group_member", "replace_group_access"}:
        group_key = (
            str(
                action.values.get(
                    "source_group_key"
                    if kind == "remove_group_member"
                    else "destination_group_key",
                    "",
                )
            )
            if kind != "replace_group_access"
            else action.target_key
        )
        group_id = _mapping(mappings, "group", group_key)
        path = f"/api/access/groups/{group_id or ''}"
        if kind == "replace_group_access":
            return {
                "read_group": _step("GET", path, 200),
                "replace_group_access": _step(
                    "PUT", f"{path}/access", 200, "groups", group_id, "update", 1, ("group_access",)
                ),
            }
        return {
            "read_group": _step("GET", path, 200),
            "replace_group_members": _step(
                "PUT", f"{path}/members", 200, "groups", group_id, "update", 1, ("group_members",)
            ),
        }

    if kind == "end_session":
        person_key = action.target_key
        person_id = _person_id(manifest, mappings, person_key)
        return {
            "list_current_sessions": _step("GET", "/api/auth/sessions", 200, actor_key=person_key),
            "revoke_user_session": _step(
                "DELETE",
                f"/api/users/{person_id or ''}/sessions/",
                204,
                actor_key="admin",
                dynamic_session=True,
                security_event="identity.session_revocation",
                security_subject_id=person_id,
            ),
        }

    if kind in {
        "refuse_board_archive",
        "board_archive",
        "board_restore",
        "board_create_purge_target",
        "board_archive_purge_target",
        "board_purge_preview",
        "board_purge",
    }:
        purge_target = kind in {
            "board_create_purge_target",
            "board_archive_purge_target",
            "board_purge_preview",
            "board_purge",
        }
        mapping_kind = "phase_boards" if purge_target else "boards"
        board_id = _mapping(mappings, mapping_kind, action.target_key)
        if kind == "board_create_purge_target":
            return {
                "create_purge_board": _step(
                    "POST", "/api/boards", 201, "boards", board_id, "create", 1
                )
            }
        path = f"/api/boards/{board_id or ''}"
        if kind == "board_purge_preview":
            return {"preview_board_purge": _step("POST", f"{path}/purge/preview", 200)}
        if kind == "board_purge":
            return {
                "purge_board": _step("POST", f"{path}/purge", 200, "boards", board_id, "delete", 1)
            }
        write_step = (
            "archive_board_refused"
            if kind == "refuse_board_archive"
            else "restore_board"
            if kind == "board_restore"
            else "archive_purge_board"
            if kind == "board_archive_purge_target"
            else "archive_board"
        )
        is_refusal = kind == "refuse_board_archive"
        write_path = f"{path}/{'restore' if kind == 'board_restore' else 'archive'}"
        write = _step(
            "POST",
            write_path,
            403 if is_refusal else action.expected_status,
            None if is_refusal else "boards",
            None if is_refusal else board_id,
            None if is_refusal else "update",
            0 if is_refusal else 1,
        )
        return {"read_board": _step("GET", path, 200), write_step: write}

    if kind in {"openview_archive", "openview_restore"}:
        resource = str(action.values.get("resource_kind", ""))
        endpoint, entity = _OPENVIEW.get(resource, ("", ""))
        item_id = _mapping(mappings, endpoint, action.target_key) if endpoint else None
        path = f"/api/{endpoint}/{item_id or ''}"
        restoring = kind == "openview_restore"
        method = "POST" if restoring else "DELETE"
        write_path = f"{path}/restore" if restoring else path
        return {
            "read_openview_item": _step("GET", path, 200),
            "restore_openview_item" if restoring else "archive_openview_item": _step(
                method,
                write_path,
                action.expected_status if restoring else 204,
                entity,
                item_id,
                "update" if restoring else "delete",
                1,
            ),
        }

    if kind.startswith("sandbox_"):
        return _sandbox_rules(action, manifest, mappings)
    return {}


def _sandbox_rules(
    action: PhaseAction, manifest: Mapping[str, Any], mappings: Mapping[str, Mapping[str, str]]
) -> dict[str, _Step]:
    del manifest

    def save(step: str) -> _Step:
        del step
        return _step("PUT", "/api/sandbox/document", 200, "sandbox_documents", None, "update", 1)

    def preview(step: str) -> _Step:
        del step
        return _step("POST", "/api/sandbox/publication-previews", 200)

    version_key = str(action.values.get("version_key", ""))
    if action.kind == "sandbox_edit_publish":
        open_key = str(action.values.get("open_version_key", ""))
        edited_key = str(action.values.get("edit_publish_version_key", ""))
        return {
            "load_document": _step("GET", "/api/sandbox/document", 200),
            "save_edited_document": save("save_edited_document"),
            "preview_edited_document": preview("preview_edited_document"),
            "publish_edited_document": _step(
                "POST",
                "/api/sandbox/publications",
                201,
                "sandbox_versions",
                _mapping(mappings, "sandbox_versions", edited_key),
                "create",
                1,
                ("sandbox_publications",),
            ),
            "save_open_document": save("save_open_document"),
            "preview_open_document": preview("preview_open_document"),
            "publish_open_document": _step(
                "POST",
                "/api/sandbox/publications",
                201,
                "sandbox_versions",
                _mapping(mappings, "sandbox_versions", open_key),
                "create",
                1,
                ("sandbox_publications",),
            ),
        }
    if action.kind in {"sandbox_close_empty_publish", "sandbox_reopen_empty_publish"}:
        suffix = "closed" if action.kind == "sandbox_close_empty_publish" else "reopened"
        version_id = _mapping(mappings, "sandbox_versions", version_key)
        return {
            "load_document": _step("GET", "/api/sandbox/document", 200),
            f"save_{suffix}_document": save(f"save_{suffix}_document"),
            f"preview_{suffix}_document": preview(f"preview_{suffix}_document"),
            f"publish_{suffix}_document": _step(
                "POST",
                "/api/sandbox/publications",
                201,
                "sandbox_versions",
                version_id,
                "create",
                1,
                ("sandbox_publications",),
            ),
        }
    restore_key = str(action.values.get("restore_version_key", ""))
    checkpoint_key = str(action.values.get("checkpoint_version_key", ""))
    version_id = _mapping(mappings, "sandbox_versions", version_key)
    restore_id = _mapping(mappings, "sandbox_versions", restore_key)
    checkpoint_id = _mapping(mappings, "sandbox_versions", checkpoint_key)
    return {
        "load_document": _step("GET", "/api/sandbox/document", 200),
        "list_versions_before_restore": _step("GET", "/api/sandbox/versions", 200),
        "restore_open_version_to_draft": _step(
            "POST",
            f"/api/sandbox/versions/{restore_id or ''}/restorations",
            201,
            "sandbox_documents",
            None,
            "update",
            1,
            ("sandbox_versions",),
        ),
        "list_versions_after_restore": _step("GET", "/api/sandbox/versions", 200),
        "read_before_restore_checkpoint": _step(
            "GET", f"/api/sandbox/versions/{checkpoint_id or ''}", 200
        ),
        "preview_restored_document": preview("preview_restored_document"),
        "publish_restored_document": _step(
            "POST",
            "/api/sandbox/publications",
            201,
            "sandbox_versions",
            version_id,
            "create",
            1,
            ("sandbox_publications",),
        ),
    }
