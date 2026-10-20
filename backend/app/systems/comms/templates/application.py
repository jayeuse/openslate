"""One locked, validated multi-channel proposal; the caller owns commit or full rollback."""

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.capabilities import POSTER_CAPABILITIES, validate_capability_configuration
from app.systems.comms.conversations.mutations import retain_read
from app.systems.comms.conversations.service import require_channel
from app.systems.comms.settings import service
from app.systems.comms.settings.resolution import (
    Scope,
    _paired_hours,
    locked_keys,
    scope_context,
    validate_settings_patch,
)
from app.systems.comms.settings.schemas import CapabilityConfiguration
from app.systems.comms.templates.models import CommsTemplate
from app.systems.comms.templates.schemas import (
    ApplyPreviewItem,
    ApplyResultItem,
    CapabilityPreview,
    TemplateApply,
    TemplateApplyPreview,
    TemplateApplyResult,
    TemplateCapabilities,
)


@dataclass
class Target:
    scope: Scope
    patch: dict[str, Any]
    capabilities: CapabilityConfiguration | None


@dataclass
class Application:
    targets: list[Target]
    preview: TemplateApplyPreview
    result: TemplateApplyResult
    etag: str


def plan(db: Session, actor: User, source: CommsTemplate, request: TemplateApply) -> Application:
    scopes: list[Scope] = [
        {"kind": "channel", "id": identity} for identity in request.conversation_ids
    ]
    for scope in sorted(scopes, key=lambda item: str(item.get("id"))):
        service.lock_scope(db, actor, scope)
        room = scope_context(db, scope).conversation
        assert room is not None
        require_channel(room)
    setting_locks, capability_locks = locked_keys(db, "setting"), locked_keys(db, "capability")
    previews, results, targets, versions = [], [], [], []
    for scope in scopes:
        current = service.settings(db, scope).overrides
        before = {key: value for key, value in current.items() if key != "dm_rule"}
        after = deepcopy(before)
        skipped = [key for key in request.keys if key in setting_locks]
        applied = [
            key
            for key in request.keys
            if key not in setting_locks and key in source.document["settings"]
        ]
        for key in applied:
            after[key] = deepcopy(source.document["settings"][key])
        if not _paired_hours(after):
            raise error("comms_settings_invalid", "Apply both quiet-hour endpoints", 422)
        patch = {
            key: after[key] for key in applied if key not in before or before[key] != after[key]
        }
        if set(patch) & {"quiet_hours_start", "quiet_hours_end"}:
            patch.update(
                {
                    key: after[key]
                    for key in ("quiet_hours_start", "quiet_hours_end")
                    if key in after
                }
            )
        if patch:
            validate_settings_patch(db, scope, patch)
        old = service.configuration(db, scope)
        new = old.model_copy(deep=True)
        cap_preview = None
        chosen, cap_skipped = [], []
        if "capabilities" in source.document:
            proposed = TemplateCapabilities.model_validate(source.document["capabilities"])
            cap_skipped = [key for key in request.capability_keys if key in capability_locks]
            chosen = [key for key in request.capability_keys if key not in capability_locks]
            new.group_grants = [
                grant for grant in old.group_grants if grant.capability not in chosen
            ] + [grant for grant in proposed.group_grants if grant.capability in chosen]
            new.group_grants.sort(key=lambda grant: (grant.capability, str(grant.group_id)))
            for key in chosen:
                if key in POSTER_CAPABILITIES:
                    new.everyone.pop(key, None)
                    if key in proposed.everyone:
                        new.everyone[key] = proposed.everyone[key]
            validate_capability_configuration(db, scope, new.model_dump(mode="json"))
            cap_preview = CapabilityPreview(
                before=TemplateCapabilities.model_validate(old.model_dump(exclude={"scope"})),
                after=TemplateCapabilities.model_validate(new.model_dump(exclude={"scope"})),
                skipped_locked=cap_skipped,
            )
        identity = scope["id"]
        previews.append(
            ApplyPreviewItem(
                conversation_id=identity,
                before=before,
                after=after,
                skipped_locked_keys=skipped,
                capabilities=cap_preview,
            )
        )
        results.append(
            ApplyResultItem(
                conversation_id=identity,
                applied_keys=applied,
                skipped_locked_keys=skipped,
                applied_capabilities=chosen if cap_preview else None,
                skipped_locked_capabilities=cap_skipped if cap_preview else None,
            )
        )
        targets.append(Target(scope, patch, new if new != old else None))
        versions.append(service.version(db, scope))
    binding = {
        "purpose": "comms-template-apply-v1",
        "org": str(bound_organization(db)),
        "actor": str(actor.id),
        "template": str(source.id),
        "revision": source.revision,
        "document": source.document,
        "request": request.model_dump(mode="json"),
        "targets": versions,
    }
    etag = '"' + hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest() + '"'
    return Application(
        targets, TemplateApplyPreview(items=previews), TemplateApplyResult(items=results), etag
    )


def apply(db: Session, actor: User, proposal: Application) -> bool:
    changed = False
    for target in proposal.targets:
        if target.patch:
            service.patch_settings(db, target.scope, target.patch)
            changed = True
        if target.capabilities is not None:
            service.replace_configuration(db, target.scope, target.capabilities)
            changed = True
        db.flush()
        room = scope_context(db, target.scope).conversation
        assert room is not None
        retain_read(db, actor, room)
    return changed
