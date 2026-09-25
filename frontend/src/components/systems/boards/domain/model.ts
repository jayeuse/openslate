import {
  FILTER_OPERATORS,
  OPENVIEW_MODULE_IDS,
  decodeAudienceRef,
  getModuleDefinition,
  type FilterClause,
  type FilterGroup,
  type AudienceRef,
  type OpenViewModuleId,
  type OpenViewWidget,
} from "../../openview/domain/model";
import { defaultWidget } from "./defaults";

import {
  DEFAULT_BOARD_ID,
  BOARD_SNAPSHOT_DATE,
  BOARD_TIMEZONE,
  BOARD_DEFAULT_RECURRENCE_END_DATE,
  BOARD_UNRESOLVED_PREFIX,
  BOARD_ATTACHMENT_TYPES,
  BOARD_INPUT_LIMITS,
} from "./model-types";
import type {
  BoardSection,
  BoardStatus,
  BoardRecurrence,
  BoardAnnouncementStatus,
  BoardAudience,
  BoardAudienceLookup,
  BoardWidget,
  SampleBoard,
  BoardAttachment,
  BoardLink,
  BoardEvent,
  BoardAnnouncementRevision,
  BoardAnnouncement,
  BoardRecordPlacement,
  BoardReminder,
  BoardPersonalState,
  BoardActivityEntry,
  BoardTemplate,
  BoardReference,
  BoardDecodeOptions,
} from "./model-types";

export * from "./model-types";
export * from "./defaults";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampFallback = `${BOARD_SNAPSHOT_DATE}T00:00:00.000Z`;
const defaultRoles = [
  { id: "sample-admin", name: "Administrator" },
  { id: "sample-member", name: "Member" },
] as const;
const defaultDepartments = [
  { id: "operations", name: "Operations" },
  { id: "customer-service", name: "Customer service" },
  { id: "finance", name: "Finance" },
  { id: "commercial", name: "Commercial" },
] as const;

type StoredRecord = Record<string, unknown>;

function isBoardDecodeOptions(
  value: BoardDecodeOptions | readonly BoardReference[],
): value is BoardDecodeOptions {
  return !Array.isArray(value);
}

function isRecord(value: unknown): value is StoredRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeStoredIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function uniqueStrings(values: readonly string[], limit = Infinity): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isSafeStoredIdentifier(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function firstStableIdWins<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function text(value: unknown, limit: number, fallback = ""): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : fallback;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

function timestamp(value: unknown, fallback = timestampFallback): string {
  if (typeof value !== "string" || value.length > 64) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return timestamp(value, "") || null;
}

function optionalExpirationTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const candidate = value.trim();
    if (datePattern.test(candidate)) {
      if (!validDate(candidate)) return null;
      const exclusiveEnd = new Date(`${candidate}T00:00:00.000Z`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      return exclusiveEnd.toISOString();
    }
  }
  return optionalTimestamp(value);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function uniqueNameMatch<T extends { id: string; name: string }>(
  values: readonly T[] | undefined,
  name: string,
): T | undefined {
  const matches = (values ?? []).filter((value) => value.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function departmentLookup(lookup: BoardAudienceLookup | undefined) {
  return lookup?.departments === undefined
    ? defaultDepartments
    : lookup.departments;
}

function identityLookup(lookup: BoardAudienceLookup | undefined) {
  return lookup?.identities ?? [];
}

function openViewAudienceLookup(lookup: BoardAudienceLookup | undefined) {
  return {
    roles: [...(lookup?.roles ?? [])].map(({ id, name }) => ({ id, name })),
    identities: [...(lookup?.identities ?? [])].map(({ id, name }) => ({
      id,
      name,
    })),
  };
}

function boardContext(
  options?: BoardDecodeOptions | readonly BoardReference[],
): BoardDecodeOptions {
  if (options === undefined) return {};
  if (Array.isArray(options)) {
    const boards: BoardReference[] = [];
    for (const option of options) {
      if (
        isRecord(option) &&
        isSafeStoredIdentifier(option.id) &&
        typeof option.name === "string"
      )
        boards.push({ id: option.id, name: option.name });
    }
    return { boards };
  }
  return isBoardDecodeOptions(options) ? options : {};
}

function resolveBoardId(
  value: StoredRecord,
  boards: readonly BoardReference[] | undefined,
): string {
  const explicit = value.boardId;
  if (isSafeStoredIdentifier(explicit)) return explicit;

  const nameValue = [value.board, value.boardName, value.boardTitle].find(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (nameValue) {
    const match = uniqueNameMatch(boards, nameValue.trim());
    if (match) return match.id;
    const unresolved = slug(nameValue);
    if (unresolved) return `${BOARD_UNRESOLVED_PREFIX}${unresolved}`;
  }
  return DEFAULT_BOARD_ID;
}

function resolveAuthorId(
  value: StoredRecord,
  lookup: BoardAudienceLookup | undefined,
): string {
  if (isSafeStoredIdentifier(value.authorId)) return value.authorId;
  if (typeof value.authorId === "string") {
    const match = uniqueNameMatch(identityLookup(lookup), value.authorId);
    if (match) return match.id;
  }
  if (typeof value.author === "string") {
    const match = uniqueNameMatch(identityLookup(lookup), value.author);
    if (match) return match.id;
  }
  return "sample-mara";
}

function normalizeSection(value: unknown): BoardSection {
  if (typeof value !== "string") return "overview";
  const normalized = value.trim().toLowerCase();
  if (normalized === "calendar") return "calendar";
  if (normalized === "announcements" || normalized === "announcement")
    return "announcements";
  return "overview";
}

function normalizeStatus(value: unknown, archived?: unknown): BoardStatus {
  if (value === "archived" || archived === true) return "archived";
  return "active";
}

function normalizeRecurrence(value: unknown): BoardRecurrence {
  if (typeof value !== "string") return "none";
  const normalized = value.trim().toLowerCase();
  if (normalized === "daily") return "daily";
  if (normalized === "weekly") return "weekly";
  if (normalized === "monthly") return "monthly";
  return "none";
}

function normalizeAnnouncementStatus(
  value: unknown,
  source: StoredRecord,
): BoardAnnouncementStatus {
  if (
    value === "draft" ||
    value === "published" ||
    value === "scheduled" ||
    value === "archived"
  )
    return value;
  if (source.archived === true) return "archived";
  if (source.draft === true) return "draft";
  if (source.scheduled === true) return "scheduled";
  if (source.published === true) return "published";
  return "published";
}

function normalizeWidgetType(value: unknown): OpenViewWidget["type"] | null {
  if (value === "summary" || value === "workload" || value === "records")
    return value;
  if (value === "chart") return "chart";
  if (value === "Summary") return "summary";
  if (value === "Workload") return "workload";
  if (value === "OpenView" || value === "Records") return "records";
  return null;
}

function normalizeRefresh(value: unknown): OpenViewWidget["refresh"] {
  if (value === "one-minute" || value === "Every minute") return "one-minute";
  if (value === "five-minutes" || value === "Every 5 minutes")
    return "five-minutes";
  return "manual";
}

function normalizeModuleId(value: unknown): OpenViewModuleId {
  return typeof value === "string" &&
    (OPENVIEW_MODULE_IDS as readonly string[]).includes(value)
    ? (value as OpenViewModuleId)
    : "service-requests";
}

function normalizeFilters(
  value: unknown,
  moduleId: OpenViewModuleId,
): FilterGroup {
  const source = isRecord(value) ? value : {};
  const logic = source.logic === "or" ? "or" : "and";
  const allowed = new Set(
    getModuleDefinition(moduleId).fields.map((field) => field.id),
  );
  const clauses = Array.isArray(source.clauses)
    ? source.clauses.flatMap((raw): FilterClause[] => {
        if (!isRecord(raw)) return [];
        const field = text(raw.field, 80);
        const operator = raw.operator;
        if (
          !allowed.has(field) ||
          typeof operator !== "string" ||
          !(FILTER_OPERATORS as readonly string[]).includes(operator)
        )
          return [];
        return [
          {
            field,
            operator: operator as FilterClause["operator"],
            value: text(raw.value, 240),
          },
        ];
      })
    : [];
  return {
    logic,
    clauses: clauses.slice(0, BOARD_INPUT_LIMITS.maxFilterClauses),
  };
}

function normalizeAudienceRef(
  value: unknown,
  lookup?: BoardAudienceLookup,
): AudienceRef {
  return decodeAudienceRef(value, openViewAudienceLookup(lookup));
}

/** Decode the Boards-only department audience while retaining OpenView's rules. */
export function decodeBoardAudience(
  value: unknown,
  lookup: BoardAudienceLookup = {},
): BoardAudience {
  if (value === "Everyone" || value === "Organization")
    return { kind: "everyone" };
  if (value === "Only me" || value === "Private") return { kind: "private" };
  if (isRecord(value) && value.kind === "department") {
    const id = text(value.id, 128);
    if (!isSafeStoredIdentifier(id)) return { kind: "private" };
    if (!departmentLookup(lookup).some((department) => department.id === id))
      return { kind: "private" };
    return { kind: "department", id };
  }

  if (typeof value === "string" && value.startsWith("Department: ")) {
    const name = value.slice("Department: ".length).trim();
    const match = uniqueNameMatch(departmentLookup(lookup), name);
    return match ? { kind: "department", id: match.id } : { kind: "private" };
  }

  if (isRecord(value) && value.kind === "department")
    return { kind: "private" };

  // `decodeAudienceRef` intentionally turns unknown role/person names into a
  // private unresolved reference. This keeps legacy labels from authorizing a
  // board when a role or identity was renamed or duplicated.
  if (typeof value === "string" && value.startsWith("Role: ")) {
    const name = value.slice("Role: ".length).trim();
    const match = uniqueNameMatch(lookup.roles, name);
    if (match) return { kind: "role", id: match.id };
    const known = uniqueNameMatch(defaultRoles, name);
    if (known && !lookup.roles) return { kind: "role", id: known.id };
    return {
      kind: "private",
      unresolved: { kind: "role", id: slug(name) || "unknown" },
    };
  }
  if (typeof value === "string" && value.startsWith("User: ")) {
    const name = value.slice("User: ".length).trim();
    const match = uniqueNameMatch(lookup.identities, name);
    return match
      ? { kind: "identity", id: match.id }
      : {
          kind: "private",
          unresolved: { kind: "identity", id: slug(name) || "unknown" },
        };
  }
  if (isRecord(value) && (value.kind === "role" || value.kind === "identity")) {
    const kind = value.kind;
    const id = text(value.id, 128);
    const candidates = kind === "role" ? lookup.roles : lookup.identities;
    if (
      isSafeStoredIdentifier(id) &&
      candidates !== undefined &&
      candidates.filter((entry) => entry.id === id).length === 1
    )
      return { kind, id };
    return { kind: "private", unresolved: { kind, id: id || "unknown" } };
  }
  return normalizeAudienceRef(value, lookup);
}

export function normalizeBoardAudience(
  value: unknown,
  lookup: BoardAudienceLookup = {},
): BoardAudience {
  return decodeBoardAudience(value, lookup);
}

function decodeWidget(
  source: StoredRecord,
  lookup: BoardAudienceLookup = {},
  index = 0,
): BoardWidget | null {
  const rawId = source.id;
  const id = isSafeStoredIdentifier(rawId)
    ? rawId
    : `sample-board-widget-${index + 1}`;
  const type = normalizeWidgetType(source.type);
  if (!type) return null;
  const moduleId = normalizeModuleId(source.moduleId);
  const moduleDefinition = getModuleDefinition(moduleId);
  const allowedFields = new Set(
    moduleDefinition.fields.map((field) => field.id),
  );
  const fields = Array.isArray(source.fields)
    ? uniqueStrings(
        source.fields.filter(
          (field): field is string =>
            typeof field === "string" && allowedFields.has(field),
        ),
        BOARD_INPUT_LIMITS.maxWidgetFields,
      )
    : [];
  const audience = normalizeAudienceRef(
    source.audience ?? source.permission,
    lookup,
  );
  const metric =
    source.metric === "count" ||
    (typeof source.metric === "string" &&
      moduleDefinition.fields.some(
        (field) => field.id === source.metric && field.type === "number",
      ))
      ? source.metric
      : "count";
  const name = text(
    source.name,
    BOARD_INPUT_LIMITS.maxWidgetName,
    type === "records"
      ? "OpenView records"
      : `${type[0].toUpperCase()}${type.slice(1)}`,
  );
  return {
    id,
    name: name || (type === "records" ? "OpenView records" : "Widget"),
    type,
    moduleId,
    size: source.size === "full" || source.size === "Full" ? "full" : "half",
    audience,
    refresh: normalizeRefresh(source.refresh),
    pinned: source.pinned === true,
    fields:
      fields.length > 0
        ? fields
        : moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: normalizeFilters(source.filters, moduleId),
    metric,
    visualization:
      source.visualization === "line" || source.visualization === "pie"
        ? source.visualization
        : "bar",
    permission:
      typeof source.permission === "string"
        ? text(source.permission, 128, "Everyone")
        : audience.kind === "everyone"
          ? "Everyone"
          : "Only me",
  };
}

export function normalizeBoardWidget(
  value: unknown,
  lookup: BoardAudienceLookup = {},
): BoardWidget {
  const source = isRecord(value) ? value : {};
  return (
    decodeWidget(source, lookup) ??
    defaultWidget("sample-board-widget-fallback", "summary", "half", false)
  );
}

export function decodeBoardWidgets(
  raw: unknown,
  lookup: BoardAudienceLookup = {},
): BoardWidget[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      const widget = decodeWidget(entry, lookup, index);
      return widget ? [widget] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxWidgets);
}

export const decodeWidgets = decodeBoardWidgets;

function legacyRoleNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((role): role is string => typeof role === "string")
        .map((role) => role.trim().slice(0, 128))
        .filter(Boolean)
    : [];
}

function visibleRoleIds(
  source: StoredRecord,
  roles: string[],
  lookup: BoardAudienceLookup | undefined,
): string[] {
  if (Array.isArray(source.visibleRoleIds))
    return uniqueStrings(
      source.visibleRoleIds.filter(
        (id): id is string => typeof id === "string",
      ),
    );
  return uniqueStrings(
    roles.flatMap((name) => {
      const match = uniqueNameMatch(lookup?.roles, name);
      if (match) return [match.id];
      if (!lookup?.roles) {
        const known = uniqueNameMatch(defaultRoles, name);
        return known ? [known.id] : [];
      }
      return [];
    }),
  );
}

export function normalizeBoard(
  value: unknown,
  options: BoardDecodeOptions = {},
  index = 0,
): SampleBoard | null {
  if (!isRecord(value)) return null;
  const rawName = text(value.name, BOARD_INPUT_LIMITS.maxBoardName);
  if (!rawName) return null;
  const id = isSafeStoredIdentifier(value.id)
    ? value.id
    : `sample-board-${slug(rawName) || index + 1}`;
  const roles = legacyRoleNames(value.roles);
  const permission = text(value.permission, 128, "Members can view");
  const status = normalizeStatus(value.status, value.archived);
  const department = text(value.department, 120, "Organization");
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt, createdAt);
  return {
    id,
    name: rawName,
    description: text(
      value.description,
      BOARD_INPUT_LIMITS.maxBoardDescription,
    ),
    department: department || "Organization",
    status,
    defaultSection: normalizeSection(value.defaultSection ?? value.section),
    visibleRoleIds: visibleRoleIds(value, roles, options.audienceLookup),
    widgets: decodeBoardWidgets(value.widgets, options.audienceLookup),
    createdAt,
    updatedAt,
    roles,
    permission,
  };
}

export function decodeBoards(
  raw: unknown,
  options: BoardDecodeOptions = {},
): SampleBoard[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const board = normalizeBoard(entry, options, index);
      return board ? [board] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxBoards);
}

function attachment(value: unknown, index: number): BoardAttachment | null {
  if (!isRecord(value)) return null;
  const id = isSafeStoredIdentifier(value.id)
    ? value.id
    : `sample-board-attachment-${index + 1}`;
  const name = text(value.name, 160);
  const type = text(value.type, 120).toLowerCase();
  const size = value.size;
  if (
    !name ||
    !Number.isInteger(size) ||
    (size as number) < 0 ||
    (size as number) > BOARD_INPUT_LIMITS.maxAttachmentBytes ||
    !(BOARD_ATTACHMENT_TYPES as readonly string[]).includes(type)
  )
    return null;
  return { id, name, size: size as number, type };
}

function decodeAttachments(raw: unknown): BoardAttachment[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const decoded = attachment(entry, index);
      return decoded ? [decoded] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxAttachments);
}

function validExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

/**
 * Accept only the same-origin record links emitted by ContentFields. The
 * stored URL is intentionally kept as a relative canonical path so it cannot
 * redirect through an arbitrary origin when rendered later.
 */
function internalRecordId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value !== value.trim() ||
    !value.startsWith("/")
  )
    return null;

  const base = "https://openslate.invalid/";
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return null;
  }

  if (
    parsed.origin !== "https://openslate.invalid" ||
    parsed.pathname !== "/openview" ||
    parsed.hash !== ""
  )
    return null;

  const entries = Array.from(parsed.searchParams.entries());
  if (entries.length !== 1 || entries[0]?.[0] !== "record") return null;
  const recordId = entries[0][1];
  if (!isSafeStoredIdentifier(recordId)) return null;

  return value === `/openview?record=${encodeURIComponent(recordId)}`
    ? recordId
    : null;
}

function link(value: unknown, index: number): BoardLink | null {
  if (typeof value === "string") {
    const recordId = internalRecordId(value);
    if (recordId) {
      return {
        id: `sample-board-link-${index + 1}`,
        url: value,
        label: value,
        recordId,
      };
    }
    if (!validExternalUrl(value)) return null;
    return {
      id: `sample-board-link-${index + 1}`,
      url: value,
      label: value,
    };
  }
  if (!isRecord(value)) return null;
  const rawUrl = value.url;
  const internalId = internalRecordId(rawUrl);
  if (internalId) {
    if (typeof rawUrl !== "string") return null;
    if (value.recordId !== undefined && value.recordId !== internalId)
      return null;
    return {
      id: isSafeStoredIdentifier(value.id)
        ? value.id
        : `sample-board-link-${index + 1}`,
      url: rawUrl,
      label: text(value.label, 160, rawUrl),
      recordId: internalId,
    };
  }
  if (!validExternalUrl(value.url)) return null;
  const recordId = isSafeStoredIdentifier(value.recordId)
    ? value.recordId
    : undefined;
  return {
    id: isSafeStoredIdentifier(value.id)
      ? value.id
      : `sample-board-link-${index + 1}`,
    url: value.url,
    label: text(value.label, 160, value.url),
    ...(recordId ? { recordId } : {}),
  };
}

function decodeLinks(raw: unknown): BoardLink[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const decoded = link(entry, index);
      return decoded ? [decoded] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxLinks);
}

function linksWithLegacyRecord(value: StoredRecord): BoardLink[] {
  const links = decodeLinks(value.links);
  if (links.length > 0 || !isSafeStoredIdentifier(value.recordId)) return links;
  return [
    {
      id: `sample-board-record-link-${value.recordId}`,
      url: `/openview?record=${encodeURIComponent(value.recordId)}`,
      label: "Linked record",
      recordId: value.recordId,
    },
  ];
}

export function normalizeBoardEvent(
  value: unknown,
  options: BoardDecodeOptions = {},
  index = 0,
): BoardEvent | null {
  if (!isRecord(value)) return null;
  const title = text(value.title, BOARD_INPUT_LIMITS.maxEventTitle);
  if (!title) return null;
  const startSource = value.start ?? value.date;
  const start =
    typeof startSource === "string" && startSource.length <= 64
      ? startSource
      : BOARD_SNAPSHOT_DATE;
  const end =
    typeof value.end === "string" && value.end.length <= 64 ? value.end : start;
  const recurrence = normalizeRecurrence(value.recurrence);
  const endDate =
    recurrence === "none"
      ? null
      : validDate(value.endDate)
        ? value.endDate
        : BOARD_DEFAULT_RECURRENCE_END_DATE;
  const id = isSafeStoredIdentifier(value.id)
    ? value.id
    : `sample-event-${slug(title) || index + 1}`;
  const audience = decodeBoardAudience(
    value.audience ?? value.visibility,
    options.audienceLookup,
  );
  const date = validDate(value.date)
    ? value.date
    : validDate(start)
      ? start
      : undefined;
  return {
    id,
    boardId: resolveBoardId(value, options.boards),
    authorId: resolveAuthorId(value, options.audienceLookup),
    title,
    details: text(value.details, BOARD_INPUT_LIMITS.maxEventDetails),
    location: text(value.location, 240),
    start,
    end,
    allDay:
      typeof value.allDay === "boolean" ? value.allDay : date !== undefined,
    timezone: text(value.timezone, 80, BOARD_TIMEZONE) || BOARD_TIMEZONE,
    audience,
    recurrence,
    endDate,
    attachments: decodeAttachments(value.attachments),
    links: linksWithLegacyRecord(value),
    archived: value.archived === true,
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    ...(date ? { date } : {}),
    ...(typeof value.visibility === "string"
      ? { visibility: text(value.visibility, 128) }
      : {}),
    ...(isSafeStoredIdentifier(value.recordId)
      ? { recordId: value.recordId }
      : {}),
  };
}

export function decodeBoardEvents(
  raw: unknown,
  options: BoardDecodeOptions | readonly BoardReference[] = {},
): BoardEvent[] {
  const context = boardContext(options);
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const event = normalizeBoardEvent(entry, context, index);
      return event ? [event] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxEvents);
}

function normalizeRevision(
  value: unknown,
  fallback: {
    id: string;
    authorId: string;
    title: string;
    body: string;
    audience: BoardAudience;
    expiresAt: string | null;
    attachments: BoardAttachment[];
    links: BoardLink[];
    createdAt: string;
    updatedAt: string;
  },
  lookup: BoardAudienceLookup,
): BoardAnnouncementRevision | null {
  if (!isRecord(value)) return null;
  const publishedAt = optionalTimestamp(value.publishedAt);
  if (!publishedAt) return null;
  return {
    id: isSafeStoredIdentifier(value.id)
      ? value.id
      : `${fallback.id}:published`,
    authorId: isSafeStoredIdentifier(value.authorId)
      ? value.authorId
      : fallback.authorId,
    title: text(
      value.title,
      BOARD_INPUT_LIMITS.maxAnnouncementTitle,
      fallback.title,
    ),
    body: text(
      value.body,
      BOARD_INPUT_LIMITS.maxAnnouncementBody,
      fallback.body,
    ),
    audience:
      value.audience === undefined
        ? fallback.audience
        : decodeBoardAudience(value.audience, lookup),
    expiresAt:
      value.expiresAt === undefined
        ? fallback.expiresAt
        : optionalExpirationTimestamp(value.expiresAt),
    publishedAt,
    createdAt: timestamp(value.createdAt, fallback.createdAt),
    updatedAt: timestamp(value.updatedAt, fallback.updatedAt),
    attachments: decodeAttachments(value.attachments),
    links: decodeLinks(value.links),
  };
}

export function normalizeBoardAnnouncement(
  value: unknown,
  options: BoardDecodeOptions = {},
  index = 0,
): BoardAnnouncement | null {
  if (!isRecord(value)) return null;
  const title = text(value.title, BOARD_INPUT_LIMITS.maxAnnouncementTitle);
  const body = text(value.body, BOARD_INPUT_LIMITS.maxAnnouncementBody);
  if (!title || !body) return null;
  const id = isSafeStoredIdentifier(value.id)
    ? value.id
    : `sample-announcement-${slug(title) || index + 1}`;
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt, createdAt);
  const status = normalizeAnnouncementStatus(value.status, value);
  const publishAt =
    optionalTimestamp(value.publishAt) ??
    (status === "published" ? createdAt : null);
  const expiresAt = optionalExpirationTimestamp(
    value.expiresAt ?? value.expires,
  );
  const audience = decodeBoardAudience(value.audience, options.audienceLookup);
  const attachments = decodeAttachments(value.attachments);
  const links = decodeLinks(value.links);
  const authorId = resolveAuthorId(value, options.audienceLookup);
  const revisionFallback = {
    id,
    authorId,
    title,
    body,
    audience,
    expiresAt,
    attachments,
    links,
    createdAt,
    updatedAt,
  };
  const revision =
    normalizeRevision(
      value.publishedRevision,
      revisionFallback,
      options.audienceLookup ?? {},
    ) ??
    (status === "published" && publishAt
      ? {
          id: `${id}:published`,
          authorId,
          title,
          body,
          audience,
          expiresAt,
          publishedAt: publishAt,
          createdAt,
          updatedAt,
          attachments,
          links,
        }
      : null);
  const expires =
    typeof value.expires === "string" ? text(value.expires, 64) : undefined;
  return {
    id,
    boardId: resolveBoardId(value, options.boards),
    authorId,
    title,
    body,
    audience,
    status,
    publishAt,
    expiresAt,
    pinned: value.pinned === true,
    attachments,
    links,
    createdAt,
    updatedAt,
    publishedRevision: revision,
    ...(expires !== undefined ? { expires } : {}),
    draft: status === "draft",
    published: status === "published",
  };
}

export function decodeBoardAnnouncements(
  raw: unknown,
  options: BoardDecodeOptions = {},
): BoardAnnouncement[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const announcement = normalizeBoardAnnouncement(entry, options, index);
      return announcement ? [announcement] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxAnnouncements);
}

export const decodeAnnouncements = decodeBoardAnnouncements;

export function normalizeBoardRecordPlacement(
  value: unknown,
  options: BoardDecodeOptions = {},
  index = 0,
): BoardRecordPlacement | null {
  const source: StoredRecord =
    typeof value === "string"
      ? { recordId: value }
      : isRecord(value)
        ? value
        : {};
  const recordId = source.recordId ?? source.id;
  if (!isSafeStoredIdentifier(recordId)) return null;
  const boardId = resolveBoardId(source, options.boards);
  const position =
    typeof source.position === "number" &&
    Number.isInteger(source.position) &&
    source.position >= 0
      ? source.position
      : index;
  return {
    id: isSafeStoredIdentifier(source.id)
      ? source.id
      : `sample-board-placement-${boardId}-${recordId}`,
    boardId,
    recordId,
    moduleId: normalizeModuleId(source.moduleId),
    position,
    pinned: source.pinned !== false,
    createdAt: timestamp(source.createdAt),
    updatedAt: timestamp(source.updatedAt),
  };
}

export function decodeBoardRecordPlacements(
  raw: unknown,
  options: BoardDecodeOptions = {},
): BoardRecordPlacement[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const placement = normalizeBoardRecordPlacement(entry, options, index);
      return placement ? [placement] : [];
    }),
  );
}

export const decodeRecordPlacements = decodeBoardRecordPlacements;

function decodeReminder(value: unknown, index: number): BoardReminder | null {
  if (!isRecord(value)) return null;
  const eventId = value.eventId;
  const identityId = value.identityId;
  if (!isSafeStoredIdentifier(eventId) || !isSafeStoredIdentifier(identityId))
    return null;
  const occurrenceStart = text(value.occurrenceStart, 64);
  if (!occurrenceStart) return null;
  const status =
    value.status === "dismissed" || value.status === "fired"
      ? value.status
      : "pending";
  return {
    id: isSafeStoredIdentifier(value.id)
      ? value.id
      : `sample-board-reminder-${eventId}-${index + 1}`,
    eventId,
    identityId,
    occurrenceStart,
    dueAt: text(value.dueAt, 64, occurrenceStart),
    status,
    createdAt: timestamp(value.createdAt),
  };
}

export function normalizeBoardPersonalState(
  value: unknown,
): BoardPersonalState {
  const source = isRecord(value) ? value : {};
  const values = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? uniqueStrings(
          candidate.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        )
      : [];
  const calendarView =
    source.calendarView === "agenda" || source.calendarView === "Agenda"
      ? "agenda"
      : "month";
  const homeBoardId = isSafeStoredIdentifier(source.homeBoardId)
    ? source.homeBoardId
    : null;
  return {
    identityId: isSafeStoredIdentifier(source.identityId)
      ? source.identityId
      : "sample-mara",
    favoriteBoardIds: values(source.favoriteBoardIds ?? source.favorites),
    homeBoardId,
    calendarView,
    readAnnouncementIds: values(source.readAnnouncementIds ?? source.read),
    bookmarkedAnnouncementIds: values(
      source.bookmarkedAnnouncementIds ?? source.bookmarks,
    ),
    reminders: firstStableIdWins(
      (Array.isArray(source.reminders) ? source.reminders : []).flatMap(
        (entry, index) => {
          const reminder = decodeReminder(entry, index);
          return reminder ? [reminder] : [];
        },
      ),
    ),
  };
}

export function decodeBoardPersonalState(value: unknown): BoardPersonalState {
  return normalizeBoardPersonalState(value);
}

export function normalizeBoardActivity(
  value: unknown,
  index = 0,
): BoardActivityEntry | null {
  if (!isRecord(value)) return null;
  const boardId = isSafeStoredIdentifier(value.boardId)
    ? value.boardId
    : DEFAULT_BOARD_ID;
  const actorId = isSafeStoredIdentifier(value.actorId)
    ? value.actorId
    : "sample-mara";
  const targetType =
    value.targetType === "widget" ||
    value.targetType === "event" ||
    value.targetType === "announcement" ||
    value.targetType === "placement"
      ? value.targetType
      : "board";
  return {
    id: isSafeStoredIdentifier(value.id)
      ? value.id
      : `sample-board-activity-${index + 1}`,
    boardId,
    actorId,
    action: text(value.action, 120, "Updated board"),
    targetType,
    targetId: isSafeStoredIdentifier(value.targetId) ? value.targetId : boardId,
    detail: text(value.detail, 400),
    createdAt: timestamp(value.createdAt),
  };
}

export function decodeBoardActivity(raw: unknown): BoardActivityEntry[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const activity = normalizeBoardActivity(entry, index);
      return activity ? [activity] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxActivity);
}

export function normalizeBoardTemplate(
  value: unknown,
  lookup: BoardAudienceLookup = {},
  index = 0,
): BoardTemplate | null {
  if (!isRecord(value)) return null;
  const name = text(value.name, BOARD_INPUT_LIMITS.maxTemplateName);
  if (!name) return null;
  const createdAt = timestamp(value.createdAt);
  return {
    id: isSafeStoredIdentifier(value.id)
      ? value.id
      : `sample-board-template-${slug(name) || index + 1}`,
    name,
    description: text(
      value.description,
      BOARD_INPUT_LIMITS.maxBoardDescription,
    ),
    department: text(value.department, 120, "Organization") || "Organization",
    defaultSection: normalizeSection(value.defaultSection),
    widgets: decodeBoardWidgets(value.widgets, lookup),
    createdAt,
    updatedAt: timestamp(value.updatedAt, createdAt),
  };
}

export function decodeBoardTemplates(
  raw: unknown,
  lookup: BoardAudienceLookup = {},
): BoardTemplate[] {
  if (!Array.isArray(raw)) return [];
  return firstStableIdWins(
    raw.flatMap((entry, index) => {
      const template = normalizeBoardTemplate(entry, lookup, index);
      return template ? [template] : [];
    }),
  ).slice(0, BOARD_INPUT_LIMITS.maxTemplates);
}
