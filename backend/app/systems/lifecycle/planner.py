"""Compatibility exports for lifecycle planning."""

from app.systems.lifecycle.planning import (
    build_lifecycle_plan,
    impact_response,
    plan_lifecycle,
)
from app.systems.lifecycle.planning_scope import (
    LifecyclePlan,
    LifecycleScope,
    canonical_lifecycle_digest,
    load_lifecycle_scope,
)

__all__ = [
    "LifecyclePlan",
    "LifecycleScope",
    "build_lifecycle_plan",
    "canonical_lifecycle_digest",
    "impact_response",
    "load_lifecycle_scope",
    "plan_lifecycle",
]
