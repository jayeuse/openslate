"""Import all ORM models so runtime metadata and relationship mappings are complete."""

from app.systems.access.identity.models import (  # noqa: F401
    IdentityRateLimitBucket,
    IdentitySession,
)
from app.systems.access.policy.models import (  # noqa: F401
    AccessDefaultDepartment,
    AccessDefaultGroup,
    AccessGroup,
    AccessGroupMember,
    AccessPolicyDefaults,
    AccessPolicyVersion,
    AccessRule,
)
from app.systems.access.service_identities.models import ServiceIdentity  # noqa: F401
from app.systems.access.users.models import Role, User, UserDepartment  # noqa: F401
from app.systems.boards.announcement_models import (  # noqa: F401
    BoardAnnouncement,
    BoardAnnouncementRevision,
)
from app.systems.boards.announcement_personal_models import (  # noqa: F401
    BoardAnnouncementPersonalState,
)
from app.systems.boards.attachment_models import (  # noqa: F401
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.boards.event_models import BoardEvent  # noqa: F401
from app.systems.boards.models import (  # noqa: F401
    Board,
    BoardGrant,
    BoardRecordPlacement,
    BoardWidget,
)
from app.systems.boards.personal_models import BoardFavorite, BoardHome  # noqa: F401
from app.systems.boards.record_link_models import (  # noqa: F401
    BoardAnnouncementRevisionRecordLink,
    BoardContentRecordLink,
)
from app.systems.boards.reminder_models import BoardEventReminder  # noqa: F401
from app.systems.boards.template_models import BoardTemplate  # noqa: F401
from app.systems.manage.audit.models import AuditLog, SecurityEvent  # noqa: F401
from app.systems.manage.workspace.models import WorkspaceProfile  # noqa: F401
from app.systems.openview.charts.models import UserChartPreference  # noqa: F401
from app.systems.openview.dashboards.models import (  # noqa: F401
    Dashboard,
    DashboardDefault,
    DashboardWidget,
)
from app.systems.openview.reports.models import (  # noqa: F401
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.schedule_models import ReportSchedule  # noqa: F401
from app.systems.openview.views.models import SavedView, SavedViewDefault  # noqa: F401
from app.systems.platform.files.models import File  # noqa: F401
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork  # noqa: F401
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
