"""Import all ORM models so runtime metadata and relationship mappings are complete."""

from app.systems.audit.models import AuditLog, SecurityEvent  # noqa: F401
from app.systems.departments.models import Department  # noqa: F401
from app.systems.fields.models import Field  # noqa: F401
from app.systems.files.models import File  # noqa: F401
from app.systems.lifecycle.models import (  # noqa: F401
    LifecycleConfirmationChallenge,
    LifecycleRateLimitBucket,
    LifecycleRateLimitFailure,
)
from app.systems.modules.models import Module  # noqa: F401
from app.systems.records.models import Record  # noqa: F401
from app.systems.relationships.models import RelationshipEdge  # noqa: F401
from app.systems.users.models import Role, User  # noqa: F401
from app.systems.views.models import SavedView  # noqa: F401
from app.systems.workspace.models import WorkspaceProfile  # noqa: F401
