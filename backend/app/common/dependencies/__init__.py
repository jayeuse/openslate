from app.common.dependencies.auth import (
    CurrentIdentity,
    get_current_identity,
    get_current_user,
    require_all_capabilities,
    require_capability,
    require_fresh_capabilities,
    require_fresh_exact_admin,
    require_fresh_legacy_capabilities,
    require_legacy_capability,
    require_roles,
)
from app.systems.access.policy.authorization import authorize_workspace_capabilities

__all__ = [
    "CurrentIdentity",
    "authorize_workspace_capabilities",
    "get_current_identity",
    "get_current_user",
    "require_all_capabilities",
    "require_capability",
    "require_fresh_capabilities",
    "require_fresh_legacy_capabilities",
    "require_fresh_exact_admin",
    "require_legacy_capability",
    "require_roles",
]
