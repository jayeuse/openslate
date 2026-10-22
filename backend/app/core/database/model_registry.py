"""Import all ORM models so runtime metadata and relationship mappings are complete."""

from app.systems.access.identity.models import (  # noqa: F401
    IdentityMfaObservation,
    IdentityRateLimitBucket,
    IdentitySession,
)
from app.systems.access.policy.models import Group, GroupAccess, GroupMember  # noqa: F401
from app.systems.access.users.models import Membership, PlatformOperator, User  # noqa: F401
from app.systems.boards.attachment_models import (  # noqa: F401
    BoardAttachment,
    BoardPostRevisionAttachment,
)
from app.systems.boards.event_models import BoardEvent  # noqa: F401
from app.systems.boards.models import Board, BoardGroup, BoardWidget  # noqa: F401
from app.systems.boards.post_models import BoardPost, BoardPostRevision  # noqa: F401
from app.systems.boards.record_link_models import (  # noqa: F401
    BoardPostRevisionRecordLink,
    BoardRecordLink,
)
from app.systems.boards.reminder_models import BoardEventReminder  # noqa: F401
from app.systems.comms.conversations.models import CommsCategory as CommsCategory
from app.systems.comms.conversations.models import CommsConversation as CommsConversation
from app.systems.comms.conversations.models import CommsDirectBlock as CommsDirectBlock
from app.systems.comms.conversations.models import CommsMember as CommsMember
from app.systems.comms.jobs.models import CommsExpiredSend as CommsExpiredSend
from app.systems.comms.jobs.models import CommsExport as CommsExport
from app.systems.comms.jobs.models import CommsExportEntry as CommsExportEntry
from app.systems.comms.jobs.models import CommsExportSource as CommsExportSource
from app.systems.comms.jobs.models import CommsRetentionPolicy as CommsRetentionPolicy
from app.systems.comms.jobs.models import CommsRetentionSweep as CommsRetentionSweep
from app.systems.comms.jobs.models import CommsSchedule as CommsSchedule
from app.systems.comms.messages.interaction_models import CommsMention as CommsMention
from app.systems.comms.messages.interaction_models import CommsReaction as CommsReaction
from app.systems.comms.messages.interaction_models import CommsThread as CommsThread
from app.systems.comms.messages.interaction_models import CommsThreadFollow as CommsThreadFollow
from app.systems.comms.messages.link_models import CommsMessageAttachment as CommsMessageAttachment
from app.systems.comms.messages.link_models import CommsMessageRecordLink as CommsMessageRecordLink
from app.systems.comms.messages.models import CommsConversationCounter as CommsConversationCounter
from app.systems.comms.messages.models import CommsMessage as CommsMessage
from app.systems.comms.messages.models import CommsMessageRevision as CommsMessageRevision
from app.systems.comms.messages.models import CommsReadState as CommsReadState
from app.systems.comms.moderation.models import CommsReport as CommsReport
from app.systems.comms.realtime.models import CommsPresence as CommsPresence
from app.systems.comms.realtime.models import CommsRealtimeAdmission as CommsRealtimeAdmission
from app.systems.comms.realtime.models import CommsRealtimeGrant as CommsRealtimeGrant
from app.systems.comms.realtime.models import CommsTyping as CommsTyping
from app.systems.comms.settings.models import CommsCapabilityGrant as CommsCapabilityGrant
from app.systems.comms.settings.models import CommsMemberPreferences as CommsMemberPreferences
from app.systems.comms.settings.models import CommsPersonalPreferences as CommsPersonalPreferences
from app.systems.comms.settings.models import CommsSettingLock as CommsSettingLock
from app.systems.comms.settings.models import CommsSettings as CommsSettings
from app.systems.comms.templates.models import CommsTemplate as CommsTemplate
from app.systems.manage.audit.models import AuditLog, SecurityEvent  # noqa: F401
from app.systems.manage.backups.models import (  # noqa: F401
    BackupExportOperation,
    BackupPolicy,
    BackupRun,
    UpdateStatus,
)
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile  # noqa: F401
from app.systems.openview.charts.models import Chart  # noqa: F401
from app.systems.openview.dashboards.models import Dashboard, DashboardWidget  # noqa: F401
from app.systems.openview.reports.models import (  # noqa: F401
    Report,
    ReportRun,
    ReportRunEligibleUser,
    ReportRunRow,
)
from app.systems.openview.reports.schedule_models import ReportSchedule  # noqa: F401
from app.systems.openview.views.models import SavedView  # noqa: F401
from app.systems.platform.files.models import File  # noqa: F401
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork  # noqa: F401
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
from app.systems.sandbox.record_triggers.models import (  # noqa: F401
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
    RecordTriggerEvent,
    RecordTriggerRun,
)
from app.systems.sandbox.records.models import Record  # noqa: F401
from app.systems.sandbox.relationships.models import RelationshipEdge  # noqa: F401
from app.systems.sandbox.test_runs.models import SandboxTestRun  # noqa: F401
