"""Import all ORM models so runtime metadata and relationship mappings are complete."""

from app.systems.access.identity.models import (  # noqa: F401
    IdentityActionToken,
    IdentityCredential,
    IdentityRateLimitBucket,
    IdentitySession,
)
from app.systems.access.users.models import Role, User  # noqa: F401
from app.systems.manage.audit.models import AuditLog, SecurityEvent  # noqa: F401
from app.systems.manage.workspace.models import WorkspaceProfile  # noqa: F401
from app.systems.openview.views.models import SavedView  # noqa: F401
from app.systems.platform.files.models import File  # noqa: F401
from app.systems.platform.notifications.models import IdentityDeliveryOutbox  # noqa: F401
from app.systems.sandbox.automations.models import (  # noqa: F401
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
    PublishedAutomationEvent,
    PublishedAutomationRun,
)
from app.systems.sandbox.departments.models import Department  # noqa: F401
from app.systems.sandbox.designs.models import SandboxDocument, SandboxVersion  # noqa: F401
from app.systems.sandbox.fields.models import Field  # noqa: F401
from app.systems.sandbox.lifecycle.models import (  # noqa: F401
    LifecycleConfirmationChallenge,
    LifecycleRateLimitBucket,
    LifecycleRateLimitFailure,
)
from app.systems.sandbox.modules.models import Module  # noqa: F401
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication  # noqa: F401
from app.systems.sandbox.records.models import Record  # noqa: F401
from app.systems.sandbox.relationships.models import RelationshipEdge  # noqa: F401
from app.systems.sandbox.test_runs.models import SandboxTestRun  # noqa: F401
