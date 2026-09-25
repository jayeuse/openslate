import { departments, initialPeople, initialRoles } from "../domain/model";
import {
  initialAccessDefaults,
  initialAccessGroups,
  initialAccessHistory,
  initialAccessIdentities,
  initialAccessReviews,
  initialAccessRules,
  initialAccessTemplates,
  initialDeletedAccessIdentities,
  type AccessDefaults,
  type AccessGroup,
  type AccessReview,
  type AccessRule,
} from "../domain/policy";
import {
  adaptManageSessions,
  projectManageSessions,
  type AccessControllerSnapshot,
  type AccessHealthFinding,
  type ControllerHistoryEntry,
  type DeletedInternalIdentity,
  type ManagedGuestIdentity,
} from "../domain/controller-model";
import {
  initialManageSessions,
  type ManageSession,
} from "../../manage/state/sessions";
import {
  decodeBoardAnnouncements,
  decodeBoards,
  INITIAL_ANNOUNCEMENTS as initialAnnouncements,
  INITIAL_BOARDS as initialBoards,
  type Announcement,
  type BoardAudienceLookup,
  type SampleBoard,
} from "../../boards/domain/model";
import {
  initialDashboards,
  initialReport,
  initialReportTemplates,
  initialSavedViews,
} from "../../openview/domain/seeds";
import {
  activeAudienceIdentities,
  decodeDashboards,
  decodeReport,
  decodeReports,
  decodeSavedViews,
  projectAudienceLookup,
  toLegacyDashboard,
  toLegacyReport,
  type AudienceLookup,
} from "../../openview/domain/model";
import {
  CATEGORIES,
  CHANNELS,
  type Category,
  type Channel,
} from "../../comms/domain/model";
import { normalizeCommsConfiguration } from "../../comms/domain/configuration";
import {
  getFederatedAccess,
  type FederatedAccessOwners,
} from "../adapters/federated-adapters";
import type {
  SampleDraft,
  SampleRuntime,
} from "../../shared/runtime/sample-runtime";

type VersionedItems<T> = { version: 1; items: T[] };
type VersionedValue<T> = { version: 1; value: T };

const initialGuests: ManagedGuestIdentity[] = initialAccessIdentities
  .filter((identity) => identity.kind === "guest")
  .map((identity) => ({
    ...identity,
    invitation: { sentAt: "2026-09-01T00:00:00.000Z", resendCount: 0 },
  }));
const initialServices = initialAccessIdentities.filter(
  (identity) => identity.kind === "service",
);
const initialDeletedIdentities: DeletedInternalIdentity[] =
  initialDeletedAccessIdentities.map((item) => ({
    ...item,
    person:
      initialPeople.find((person) => person.id === item.identity.id) ??
      initialPeople[0],
  }));

export const ACCESS_OWNER_KEYS = [
  "access-people",
  "access-roles",
  "access-guests-v1",
  "access-services-v1",
  "access-groups-v1",
  "access-rules-v1",
  "boards-list",
  "boards-announcements",
  "views-saved",
  "views-dashboards",
  "views-report-draft",
  "views-report-templates",
  "comms-configuration",
  "commsCategories",
  "commsChannels",
  "access-defaults-v1",
  "access-templates-v1",
  "access-reviews-v1",
  "access-deleted-identities-v1",
  "manage-sessions",
  "access-history-v1",
] as const;

export type AccessReader = <T>(key: string, initial: T) => T;
export type AccessRuntimeSnapshot = {
  snapshot: AccessControllerSnapshot;
  owners: FederatedAccessOwners;
  manageSessions: ManageSession[];
  federatedFindings: AccessHealthFinding[];
};

export function readAccessProjection(
  read: AccessReader,
): AccessRuntimeSnapshot {
  // The pure federated executors may update nested arrays while constructing
  // their result. Clone each native owner before handing it to a recipe so a
  // rejected or superseded operation cannot mutate the published snapshot.
  const people = structuredClone(read("access-people", initialPeople));
  const roles = structuredClone(read("access-roles", initialRoles));
  const guestSlice = structuredClone(
    read<VersionedItems<ManagedGuestIdentity>>("access-guests-v1", {
      version: 1,
      items: initialGuests,
    }),
  );
  const serviceSlice = structuredClone(
    read<VersionedItems<(typeof initialServices)[number]>>(
      "access-services-v1",
      { version: 1, items: initialServices },
    ),
  );
  const groupSlice = structuredClone(
    read<VersionedItems<AccessGroup>>("access-groups-v1", {
      version: 1,
      items: initialAccessGroups,
    }),
  );
  const ruleSlice = structuredClone(
    read<VersionedItems<AccessRule>>("access-rules-v1", {
      version: 1,
      items: initialAccessRules,
    }),
  );
  const defaultSlice = structuredClone(
    read<VersionedValue<AccessDefaults>>("access-defaults-v1", {
      version: 1,
      value: initialAccessDefaults,
    }),
  );
  const templateSlice = structuredClone(
    read("access-templates-v1", {
      version: 1 as const,
      items: initialAccessTemplates,
    }),
  );
  const reviewSlice = structuredClone(
    read<VersionedItems<AccessReview>>("access-reviews-v1", {
      version: 1,
      items: initialAccessReviews,
    }),
  );
  const deletedSlice = structuredClone(
    read<VersionedItems<DeletedInternalIdentity>>(
      "access-deleted-identities-v1",
      { version: 1, items: initialDeletedIdentities },
    ),
  );
  const manageSessions = structuredClone(
    read<ManageSession[]>("manage-sessions", initialManageSessions),
  );
  const historySlice = structuredClone(
    read<VersionedItems<ControllerHistoryEntry>>("access-history-v1", {
      version: 1,
      items: initialAccessHistory,
    }),
  );
  const rawBoards = read<unknown>("boards-list", null);
  const rawAnnouncements = read<unknown>("boards-announcements", null);
  const rawSavedViews = read<unknown>("views-saved", initialSavedViews);
  const rawDashboards = read<unknown>("views-dashboards", null);
  const rawReportDraft = read<unknown>("views-report-draft", initialReport);
  const rawReportTemplates = read<unknown>(
    "views-report-templates",
    initialReportTemplates,
  );
  const rawCommsConfiguration = read<unknown>("comms-configuration", null);
  const commsCategories = structuredClone(
    read<Category[]>("commsCategories", CATEGORIES),
  );
  const commsChannels = structuredClone(
    read<Channel[]>("commsChannels", CHANNELS),
  );

  const openViewAudienceLookup: AudienceLookup = {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: activeAudienceIdentities(people),
  };
  const boardAudienceLookup: BoardAudienceLookup = {
    roles: roles.map(({ id, name }) => ({ id, name })),
    identities: activeAudienceIdentities(people),
    departments: ["Organization", ...departments].map((name) => ({
      id: name.toLowerCase().replaceAll(" ", "-"),
      name,
    })),
  };
  const boards: SampleBoard[] =
    rawBoards === null
      ? structuredClone(initialBoards)
      : decodeBoards(rawBoards, { audienceLookup: boardAudienceLookup });
  const announcements: Announcement[] =
    rawAnnouncements === null
      ? structuredClone(initialAnnouncements)
      : decodeBoardAnnouncements(rawAnnouncements, {
          audienceLookup: boardAudienceLookup,
        });
  const owners: FederatedAccessOwners = {
    boards,
    announcements,
    savedViews: decodeSavedViews(rawSavedViews, openViewAudienceLookup),
    dashboards: decodeDashboards(
      rawDashboards ?? structuredClone(initialDashboards),
      openViewAudienceLookup,
    ),
    reportDraft: decodeReport(rawReportDraft, openViewAudienceLookup),
    reportTemplates: decodeReports(rawReportTemplates, openViewAudienceLookup),
    commsConfiguration: normalizeCommsConfiguration(rawCommsConfiguration),
    commsCategories,
    commsChannels,
  };
  const federated = getFederatedAccess(owners, {
    roles,
    identities: people.map(({ id, name, active, accessStatus }) => ({
      id,
      name,
      status: accessStatus,
      deleted: !active,
    })),
    departments: boardAudienceLookup.departments,
  });

  return {
    snapshot: {
      people,
      roles,
      guests: guestSlice.items,
      services: serviceSlice.items,
      groups: groupSlice.items,
      rules: [...ruleSlice.items, ...federated.rules],
      defaults: defaultSlice.value,
      templates: templateSlice.items,
      reviews: reviewSlice.items,
      deletedIdentities: deletedSlice.items,
      sessions: adaptManageSessions(manageSessions),
      history: historySlice.items,
      federatedScopes: federated.scopes,
    },
    owners,
    manageSessions,
    federatedFindings: federated.findings,
  };
}

export function readAccessRuntimeSnapshot(
  runtime: Pick<SampleRuntime, "read">,
): AccessRuntimeSnapshot {
  return readAccessProjection(runtime.read);
}

export function writeAccessProjection(
  draft: SampleDraft,
  next: AccessControllerSnapshot,
  owners: FederatedAccessOwners,
  previousManageSessions: ManageSession[],
): void {
  const openViewAudienceLookup = projectAudienceLookup(next.roles, next.people);
  const dashboards = decodeDashboards(
    owners.dashboards,
    openViewAudienceLookup,
  );
  const reportDraft = decodeReport(owners.reportDraft, openViewAudienceLookup);
  const reportTemplates = decodeReports(
    owners.reportTemplates,
    openViewAudienceLookup,
  );
  draft.update("access-people", initialPeople, next.people);
  draft.update("access-roles", initialRoles, next.roles);
  draft.update(
    "access-guests-v1",
    { version: 1 as const, items: initialGuests },
    { version: 1, items: next.guests },
  );
  draft.update(
    "access-services-v1",
    { version: 1 as const, items: initialServices },
    { version: 1, items: next.services },
  );
  draft.update(
    "access-groups-v1",
    { version: 1 as const, items: initialAccessGroups },
    { version: 1, items: next.groups },
  );
  draft.update(
    "access-rules-v1",
    { version: 1 as const, items: initialAccessRules },
    { version: 1, items: next.rules },
  );
  draft.update("boards-list", initialBoards, owners.boards);
  draft.update(
    "boards-announcements",
    initialAnnouncements,
    owners.announcements,
  );
  draft.update<unknown>("views-saved", initialSavedViews, owners.savedViews);
  draft.update(
    "views-dashboards",
    initialDashboards,
    dashboards.map((dashboard) =>
      toLegacyDashboard(dashboard, openViewAudienceLookup),
    ),
  );
  draft.update(
    "views-report-draft",
    initialReport,
    toLegacyReport(reportDraft, openViewAudienceLookup),
  );
  draft.update(
    "views-report-templates",
    initialReportTemplates,
    reportTemplates.map((report) =>
      toLegacyReport(report, openViewAudienceLookup),
    ),
  );
  draft.update<unknown>("comms-configuration", null, owners.commsConfiguration);
  draft.update<Category[]>(
    "commsCategories",
    CATEGORIES,
    owners.commsCategories,
  );
  draft.update<Channel[]>("commsChannels", CHANNELS, owners.commsChannels);
  draft.update(
    "access-defaults-v1",
    { version: 1 as const, value: initialAccessDefaults },
    { version: 1, value: next.defaults },
  );
  draft.update(
    "access-templates-v1",
    { version: 1 as const, items: initialAccessTemplates },
    { version: 1, items: next.templates },
  );
  draft.update(
    "access-reviews-v1",
    { version: 1 as const, items: initialAccessReviews },
    { version: 1, items: next.reviews },
  );
  draft.update(
    "access-deleted-identities-v1",
    { version: 1 as const, items: [] as DeletedInternalIdentity[] },
    { version: 1, items: next.deletedIdentities },
  );
  draft.update(
    "manage-sessions",
    initialManageSessions,
    projectManageSessions(next.sessions, previousManageSessions),
  );
  draft.update(
    "access-history-v1",
    { version: 1 as const, items: [] as ControllerHistoryEntry[] },
    { version: 1, items: next.history },
  );
}
