"use client";

import { useEffect, useRef, useState } from "react";
import {
  useAccessController,
  ACCESS_OWNER_KEYS,
  readAccessProjection,
  type AccessRuntimeSnapshot,
} from "../../access/state/controller";
import {
  resolveControllerAccess,
  type AccessControllerSnapshot,
} from "../../access/domain/controller-utils";
import {
  getFederatedAccess,
  type FederatedAccessOwners,
} from "../../access/adapters/federated-adapters";
import { departments } from "../../access/domain/model";
import { useSampleRuntime } from "../../shared/runtime/sample-state";
import type { SampleDraft } from "../../shared/runtime/sample-runtime";
import {
  sampleOperationMessage,
  useSampleCommands,
  useSampleResource,
} from "../../shared/runtime/sample-async";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import { releaseLocalAttachment } from "../../shared/runtime/local-attachments";
import { datetimeInputToUtc } from "@/lib/date-time";
import {
  BOARD_TIMEZONE,
  INITIAL_BOARDS,
  INITIAL_EVENTS,
  INITIAL_ANNOUNCEMENTS,
  decodeBoards,
  decodeBoardEvents,
  decodeBoardAnnouncements,
  decodeBoardRecordPlacements,
  decodeBoardPersonalState,
  decodeBoardTemplates,
  decodeBoardActivity,
  type BoardAudienceLookup,
  type BoardEvent,
  type BoardPersonalState,
  type BoardReminder,
  type Board,
} from "../domain/model";
import {
  canViewBoardAudience,
  dueBoardReminders,
  expandBoardEventOccurrences,
  getReminderDueAt,
  type BoardReminderTiming,
  type BoardViewer,
} from "../domain/content";
import {
  executeBoardCommand,
  type BoardCommand,
  type BoardCommandContext,
  type BoardMutationResult,
  type BoardsState,
} from "../domain/commands";

export const BOARD_MANAGER_ID = "sample-mara";
export const BOARD_KEYS = {
  boards: "boards-list",
  events: "boards-events",
  announcements: "boards-announcements",
  placements: "platformBoardRecords",
  personal: "boards-personal-v1",
  templates: "boards-templates-v1",
  activity: "boards-activity-v1",
} as const;
export const BOARD_OWNER_KEYS = [
  ...Object.values(BOARD_KEYS),
  "records",
  "manage-settings",
  "platformNotifications",
  ...ACCESS_OWNER_KEYS,
] as const;
type RawState = Record<keyof BoardsState, unknown>;

export type BoardReminderCandidate = {
  reminder: BoardReminder;
  event: BoardEvent;
};

export type BoardReminderEligibilityOptions = {
  state: BoardsState;
  personal: BoardPersonalState | undefined;
  actorId: string;
  viewer: BoardViewer | undefined;
  now: string;
  preview?: boolean;
  canViewBoard: (boardId: string) => boolean;
  canManageBoard: (boardId: string) => boolean;
};

export function canSetBoardReminder(
  event: BoardEvent,
  viewer: BoardViewer | undefined,
  canViewBoard: (boardId: string) => boolean,
  canManageBoard: (boardId: string) => boolean,
): boolean {
  return Boolean(
    viewer &&
    viewer.active &&
    (viewer.accessStatus ?? "active") === "active" &&
    canViewBoard(event.boardId) &&
    (canManageBoard(event.boardId) ||
      canViewBoardAudience(event.audience, viewer, event.authorId)),
  );
}

export function findEligibleBoardReminders({
  state,
  personal,
  actorId,
  viewer,
  now,
  preview = false,
  canViewBoard,
  canManageBoard,
}: BoardReminderEligibilityOptions): BoardReminderCandidate[] {
  if (
    preview ||
    !personal ||
    personal.identityId !== actorId ||
    !viewer ||
    viewer.id !== actorId ||
    !viewer.active ||
    (viewer.accessStatus ?? "active") !== "active"
  )
    return [];

  return dueBoardReminders(personal.reminders, now).flatMap((reminder) => {
    if (reminder.identityId !== actorId) return [];
    const event = state.events.find((item) => item.id === reminder.eventId);
    if (!event || event.archived) return [];
    const board = state.boards.find((item) => item.id === event.boardId);
    if (
      !board ||
      board.status !== "active" ||
      !canSetBoardReminder(event, viewer, canViewBoard, canManageBoard)
    )
      return [];
    return [{ reminder, event }];
  });
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function decodeBoardsState(
  raw: RawState,
  audienceLookup: BoardAudienceLookup,
): BoardsState {
  const boards = decodeBoards(raw.boards ?? INITIAL_BOARDS, { audienceLookup });
  const options = { boards, audienceLookup };
  const personal = Object.fromEntries(
    Object.entries(object(raw.personal)).map(([identityId, value]) => [
      identityId,
      decodeBoardPersonalState({ ...object(value), identityId }),
    ]),
  );
  return {
    boards,
    events: decodeBoardEvents(raw.events ?? INITIAL_EVENTS, options),
    announcements: decodeBoardAnnouncements(
      raw.announcements ?? INITIAL_ANNOUNCEMENTS,
      options,
    ),
    placements: decodeBoardRecordPlacements(raw.placements ?? [], options),
    personal,
    templates: decodeBoardTemplates(raw.templates ?? [], audienceLookup),
    activity: decodeBoardActivity(raw.activity ?? []),
  };
}
function lookupFrom(
  state: Pick<AccessRuntimeSnapshot["snapshot"], "roles" | "people">,
): BoardAudienceLookup {
  return {
    roles: state.roles,
    identities: state.people.filter(
      (person) =>
        person.active && (person.accessStatus ?? "active") === "active",
    ),
    departments: ["Organization", ...departments].map((name) => ({
      id: name.toLowerCase().replaceAll(" ", "-"),
      name,
    })),
  };
}
function boardViewerFor(
  actorId: string,
  person: AccessControllerSnapshot["people"][number] | undefined,
  lookup: BoardAudienceLookup,
): BoardViewer {
  return {
    id: actorId,
    active: person?.active ?? false,
    accessStatus: person?.accessStatus,
    roleIds:
      lookup.roles
        ?.filter(
          (role) => role.id === person?.role || role.name === person?.role,
        )
        .map((role) => role.id) ?? [],
    departmentIds:
      person?.departments.map((name) =>
        name.toLowerCase().replaceAll(" ", "-"),
      ) ?? [],
  };
}

function occurrenceDateKey(
  event: BoardEvent,
  occurrenceStart: string,
): string | null {
  if (event.allDay)
    return /^\d{4}-\d{2}-\d{2}$/.test(occurrenceStart) ? occurrenceStart : null;
  const timestamp = Date.parse(occurrenceStart);
  if (!Number.isFinite(timestamp)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: event.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(timestamp));
  } catch {
    return null;
  }
}

function isCurrentEventOccurrence(
  event: BoardEvent,
  occurrenceStart: string,
): boolean {
  const date = occurrenceDateKey(event, occurrenceStart);
  if (!date) return false;
  return expandBoardEventOccurrences(event, {
    start: date,
    end: date,
  }).occurrences.some((occurrence) => occurrence.start === occurrenceStart);
}
function readBoards(
  draft: Pick<SampleDraft, "read">,
  lookup: BoardAudienceLookup,
): BoardsState {
  return decodeBoardsState(
    Object.fromEntries(
      Object.entries(BOARD_KEYS).map(([key, storageKey]) => [
        key,
        draft.read<unknown>(storageKey, null),
      ]),
    ) as RawState,
    lookup,
  );
}
function attachBoardsPolicy(
  base: AccessControllerSnapshot,
  owners: FederatedAccessOwners,
  state: BoardsState,
): AccessControllerSnapshot {
  const projection = getFederatedAccess(
    {
      ...owners,
      boards: state.boards.map((board) => ({
        ...board,
        roles: board.roles ?? [],
        permission: board.permission ?? "Members can view",
      })),
      announcements: state.announcements,
    },
    {
      departments: lookupFrom(base).departments,
      roles: base.roles,
      identities: base.people.map((person) => ({
        ...person,
        status: person.accessStatus,
        deleted: !person.active,
      })),
    },
  );
  return {
    ...base,
    rules: [
      ...base.rules.filter((rule) => !rule.id.startsWith("native:")),
      ...projection.rules,
    ],
    federatedScopes: projection.scopes,
  };
}
function attachmentIds(state: BoardsState): Set<string> {
  return new Set(
    [
      ...state.events.flatMap((event) => event.attachments),
      ...state.announcements.flatMap((announcement) => [
        ...announcement.attachments,
        ...(announcement.publishedRevision?.attachments ?? []),
      ]),
    ].map((file) => file.id),
  );
}

export type BoardsRuntimeSnapshot = {
  state: BoardsState;
  access: AccessRuntimeSnapshot;
  records: SampleRecord[];
  settings: Record<string, unknown>;
};

export function readBoardsRuntimeSnapshot(
  read: <T>(key: string, initial: T) => T,
): BoardsRuntimeSnapshot {
  const access = readAccessProjection(read);
  const lookup = lookupFrom(access.snapshot);
  const state = decodeBoardsState(
    Object.fromEntries(
      Object.entries(BOARD_KEYS).map(([key, storageKey]) => [
        key,
        read<unknown>(storageKey, null),
      ]),
    ) as RawState,
    lookup,
  );
  return {
    state,
    access,
    records: structuredClone(read("records", INITIAL_RECORDS)),
    settings: structuredClone(read("manage-settings", {})),
  };
}

function initialBoardsRuntimeSnapshot(): BoardsRuntimeSnapshot {
  const initialValues: Record<string, unknown> = {
    [BOARD_KEYS.boards]: INITIAL_BOARDS,
    [BOARD_KEYS.events]: INITIAL_EVENTS,
    [BOARD_KEYS.announcements]: INITIAL_ANNOUNCEMENTS,
  };
  return readBoardsRuntimeSnapshot((key, initial) =>
    Object.hasOwn(initialValues, key)
      ? (initialValues[key] as typeof initial)
      : initial,
  );
}

function boardCommandKey(command: BoardCommand, actorId: string): string {
  switch (command.type) {
    case "create-board":
      return "boards:board:create";
    case "save-board":
      return `boards:board:${command.draft.id}`;
    case "board-action":
      return `boards:board:${command.boardId}`;
    case "save-event":
      return `boards:event:${command.event.id}`;
    case "event-action":
      return `boards:event:${command.eventId}`;
    case "save-announcement":
      return `boards:announcement:${command.announcement.id}`;
    case "announcement-action":
      return `boards:announcement:${command.announcementId}`;
    case "place-record":
      return `boards:placement:${command.placement.id}`;
    case "remove-placement":
      return `boards:placement:${command.placementId}`;
    case "personal":
      return `boards:personal:${actorId}`;
    case "save-template":
      return `boards:template:${command.template.id}`;
    case "delete-template":
      return `boards:template:${command.templateId}`;
  }
}

function writeBoardsState(
  draft: SampleDraft,
  current: BoardsState,
  next: BoardsState,
): void {
  for (const key of Object.keys(BOARD_KEYS) as (keyof BoardsState)[]) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key]))
      draft.update<unknown>(BOARD_KEYS[key], null, next[key]);
  }
}

function removeBoardAccessRules(
  draft: SampleDraft,
  current: BoardsState,
  snapshot: AccessControllerSnapshot,
  command: BoardCommand,
): void {
  if (command.type !== "board-action" || command.action !== "delete") return;
  const scopeIds = new Set([
    `board:${command.boardId}`,
    ...(current.boards
      .find((board) => board.id === command.boardId)
      ?.widgets.map(
        (widget) => `openview:board-widget:${command.boardId}:${widget.id}`,
      ) ?? []),
  ]);
  const currentRules = {
    version: 1 as const,
    items: snapshot.rules.filter((rule) => !rule.id.startsWith("native:")),
  };
  draft.update("access-rules-v1", currentRules, (rules) => ({
    ...rules,
    items: rules.items.filter((rule) => !scopeIds.has(rule.scope.id)),
  }));
}

type BoardCommandResolution = BoardCommand | { ok: false; error: string };
type PersonalPatch =
  | Partial<BoardPersonalState>
  | ((current: BoardPersonalState) => Partial<BoardPersonalState>);

function isRejectedBoardCommand(
  value: BoardCommandResolution,
): value is { ok: false; error: string } {
  return "ok" in value;
}

export function useBoardsController(previewIdentityId: string | null = null) {
  const runtime = useSampleRuntime();
  const access = useAccessController();
  const resource = useSampleResource<BoardsRuntimeSnapshot>({
    keys: BOARD_OWNER_KEYS,
    queryKey: "boards:projection:v1",
    load: (signal) =>
      runtime.load((source) => readBoardsRuntimeSnapshot(source.read), {
        keys: BOARD_OWNER_KEYS,
        signal,
      }),
  });
  const commands = useSampleCommands();
  const [fallback] = useState(initialBoardsRuntimeSnapshot);
  const projection = resource.data ?? fallback;
  const state = projection.state;
  const accessSnapshot = projection.access.snapshot;
  const lookup = lookupFrom(accessSnapshot);
  const records = projection.records;
  const settings = projection.settings;
  const previousAttachments = useRef<Set<string>>(new Set());
  const retainedFiles = attachmentIds(state);
  const attachmentKey = [...retainedFiles].sort().join("|");
  useEffect(() => {
    const current = new Set(attachmentKey ? attachmentKey.split("|") : []);
    for (const id of previousAttachments.current)
      if (!current.has(id)) releaseLocalAttachment(id);
    previousAttachments.current = current;
  }, [attachmentKey]);
  let timezone = BOARD_TIMEZONE;
  if (typeof settings.timezone === "string") {
    try {
      new Intl.DateTimeFormat("en-PH", { timeZone: settings.timezone });
      timezone = settings.timezone;
    } catch {
      /* Keep the supported workspace default. */
    }
  }
  const locale =
    settings.locale === "Filipino"
      ? "fil-PH"
      : settings.locale === "English (US)"
        ? "en-US"
        : "en-PH";
  const actorId = previewIdentityId ?? BOARD_MANAGER_ID;
  const viewer = accessSnapshot.people.find((person) => person.id === actorId);
  const personalState =
    state.personal[actorId] ??
    decodeBoardPersonalState({ identityId: actorId });

  function contextFor(
    current: BoardsState,
    snapshot: AccessControllerSnapshot,
    owners: FederatedAccessOwners,
    currentRecords: readonly SampleRecord[],
    now: string,
    id: string,
    preview = previewIdentityId !== null,
  ): BoardCommandContext {
    const policy = attachBoardsPolicy(snapshot, owners, current);
    return {
      actorId,
      preview,
      now,
      id,
      audienceLookup: lookupFrom(snapshot),
      recordIds: currentRecords.map((record) => record.id),
      can: (boardId, permission) =>
        resolveControllerAccess(policy, {
          identityId: actorId,
          permissionId: `boards.${permission}`,
          scopePath: boardId
            ? [
                { kind: "workspace", id: "workspace" },
                { kind: "board", id: `board:${boardId}` },
              ]
            : [
                { kind: "workspace", id: "workspace" },
                { kind: "board", id: "board:organization" },
              ],
          now,
        }).decision === "allow",
    };
  }
  function can(
    boardId: string | null,
    permission: "view" | "edit" | "manage",
  ): boolean {
    return contextFor(
      state,
      accessSnapshot,
      projection.access.owners,
      records,
      new Date().toISOString(),
      "preview",
    ).can(boardId, permission);
  }

  function isPending(key?: string): boolean {
    return commands.isPending(key) || access.isPending(key);
  }

  async function runResolved(
    key: string,
    resolve: (
      current: BoardsState,
      snapshot: AccessRuntimeSnapshot,
      records: readonly SampleRecord[],
      now: string,
    ) => BoardCommandResolution,
  ): Promise<BoardMutationResult> {
    try {
      return await commands.run(key, (signal) =>
        runtime.execute<BoardMutationResult>(
          (draft) => {
            const currentAccess = readAccessProjection(draft.read);
            const current = readBoards(
              draft,
              lookupFrom(currentAccess.snapshot),
            );
            const currentRecords = structuredClone(
              draft.read<SampleRecord[]>("records", INITIAL_RECORDS),
            );
            const now = new Date().toISOString();
            const resolution = resolve(
              current,
              currentAccess,
              currentRecords,
              now,
            );
            if (isRejectedBoardCommand(resolution))
              return draft.reject(resolution);
            const result = executeBoardCommand(
              current,
              resolution,
              contextFor(
                current,
                currentAccess.snapshot,
                currentAccess.owners,
                currentRecords,
                now,
                `board-activity-${crypto.randomUUID()}`,
              ),
            );
            if (!result.result.ok) return draft.reject(result.result);
            writeBoardsState(draft, current, result.state);
            removeBoardAccessRules(
              draft,
              current,
              currentAccess.snapshot,
              resolution,
            );
            return result.result;
          },
          { keys: BOARD_OWNER_KEYS, signal },
        ),
      );
    } catch (error) {
      return {
        ok: false,
        error: sampleOperationMessage(
          error,
          "The board could not be updated. Keep the editor open and try again.",
        ),
      };
    }
  }

  function run(command: BoardCommand): Promise<BoardMutationResult> {
    return runResolved(boardCommandKey(command, actorId), () => command);
  }

  function updatePersonal(patch: PersonalPatch): Promise<BoardMutationResult> {
    return runResolved(`boards:personal:${actorId}`, (current) => {
      const currentPersonal =
        current.personal[actorId] ??
        decodeBoardPersonalState({ identityId: actorId });
      const nextPatch =
        typeof patch === "function" ? patch(currentPersonal) : patch;
      return {
        type: "personal",
        value: {
          ...currentPersonal,
          ...nextPatch,
          identityId: actorId,
        },
      };
    });
  }

  function remind(
    event: BoardsState["events"][number],
    timing: BoardReminderTiming,
    occurrenceStart: string,
  ): Promise<BoardMutationResult> {
    return runResolved(
      `boards:reminder:${actorId}:${event.id}:${occurrenceStart}`,
      (current, currentAccess, currentRecords, now) => {
        if (previewIdentityId)
          return {
            ok: false,
            error: "Reminders are unavailable in a read-only preview.",
          };
        const currentEvent = current.events.find(
          (item) => item.id === event.id,
        );
        if (!currentEvent || currentEvent.archived)
          return {
            ok: false,
            error: "This event is no longer available for reminders.",
          };
        const currentBoard = current.boards.find(
          (board) => board.id === currentEvent.boardId,
        );
        const currentContext = contextFor(
          current,
          currentAccess.snapshot,
          currentAccess.owners,
          currentRecords,
          now,
          "board-reminder",
          false,
        );
        if (
          !currentBoard ||
          currentBoard.status !== "active" ||
          !currentContext.can(currentEvent.boardId, "view")
        )
          return {
            ok: false,
            error: "You no longer have access to this board.",
          };
        const currentLookup = lookupFrom(currentAccess.snapshot);
        const currentViewer = boardViewerFor(
          actorId,
          currentAccess.snapshot.people.find((person) => person.id === actorId),
          currentLookup,
        );
        if (
          !canSetBoardReminder(
            currentEvent,
            currentViewer,
            (boardId) => currentContext.can(boardId, "view"),
            (boardId) => currentContext.can(boardId, "manage"),
          )
        )
          return {
            ok: false,
            error: "You no longer have access to this event.",
          };
        if (!isCurrentEventOccurrence(currentEvent, occurrenceStart))
          return {
            ok: false,
            error:
              "This event occurrence changed. Reopen the calendar before setting a reminder.",
          };
        let start = occurrenceStart;
        if (/^\d{4}-\d{2}-\d{2}$/.test(start))
          start = datetimeInputToUtc(`${start}T00:00`, currentEvent.timezone);
        const reminder = {
          id: `board-reminder:${event.id}:${actorId}:${occurrenceStart}`,
          eventId: currentEvent.id,
          identityId: actorId,
          occurrenceStart,
          dueAt: getReminderDueAt({ start }, timing),
          status: "pending" as const,
          createdAt: now,
        };
        const currentPersonal =
          current.personal[actorId] ??
          decodeBoardPersonalState({ identityId: actorId });
        return {
          type: "personal",
          value: {
            ...currentPersonal,
            reminders: [
              ...currentPersonal.reminders.filter(
                (item) => item.id !== reminder.id,
              ),
              reminder,
            ],
            identityId: actorId,
          },
        };
      },
    );
  }

  function cancelReminder(
    event: BoardsState["events"][number],
    occurrenceStart: string,
  ): Promise<BoardMutationResult> {
    return runResolved(
      `boards:reminder:${actorId}:${event.id}:${occurrenceStart}`,
      (current) => {
        const currentPersonal =
          current.personal[actorId] ??
          decodeBoardPersonalState({ identityId: actorId });
        return {
          type: "personal",
          value: {
            ...currentPersonal,
            identityId: actorId,
            reminders: currentPersonal.reminders.filter(
              (item) =>
                item.eventId !== event.id ||
                item.occurrenceStart !== occurrenceStart,
            ),
          },
        };
      },
    );
  }

  async function processReminders(): Promise<BoardMutationResult | undefined> {
    if (previewIdentityId || isPending()) return undefined;
    try {
      return await commands.run("boards:reminders", (signal) =>
        runtime.execute<BoardMutationResult | undefined>(
          (draft) => {
            const currentAccess = readAccessProjection(draft.read);
            const currentLookup = lookupFrom(currentAccess.snapshot);
            const current = readBoards(draft, currentLookup);
            const own = current.personal[actorId];
            if (!own) return undefined;
            const now = new Date().toISOString();
            const currentContext = contextFor(
              current,
              currentAccess.snapshot,
              currentAccess.owners,
              draft.read<SampleRecord[]>("records", INITIAL_RECORDS),
              now,
              "board-reminders",
              false,
            );
            const due = findEligibleBoardReminders({
              state: current,
              personal: own,
              actorId,
              viewer: boardViewerFor(
                actorId,
                currentAccess.snapshot.people.find(
                  (person) => person.id === actorId,
                ),
                currentLookup,
              ),
              now,
              canViewBoard: (boardId) => currentContext.can(boardId, "view"),
              canManageBoard: (boardId) =>
                currentContext.can(boardId, "manage"),
            });
            if (!due.length) return undefined;
            const ids = new Set(due.map(({ reminder }) => reminder.id));
            draft.update<unknown>(BOARD_KEYS.personal, null, {
              ...current.personal,
              [actorId]: {
                ...own,
                reminders: own.reminders.map((item) =>
                  ids.has(item.id) ? { ...item, status: "fired" } : item,
                ),
              },
            });
            draft.update<
              { id: string; title: string; recordId?: string; read: boolean }[]
            >("platformNotifications", [], (notices) => [
              ...due
                .filter(
                  ({ reminder }) =>
                    !notices.some((notice) => notice.id === reminder.id),
                )
                .map(({ reminder, event: dueEvent }) => ({
                  id: reminder.id,
                  title: `Reminder: ${dueEvent.title}`,
                  recordId: dueEvent.links.find((link) => link.recordId)
                    ?.recordId,
                  read: false,
                })),
              ...notices,
            ]);
            return { ok: true };
          },
          { keys: BOARD_OWNER_KEYS, signal },
        ),
      );
    } catch (error) {
      return {
        ok: false,
        error: sampleOperationMessage(
          error,
          "Reminders could not be updated. Try again.",
        ),
      };
    }
  }

  return {
    state,
    access,
    accessSnapshot,
    resource,
    isPending,
    pendingKeys: [...new Set([...commands.pendingKeys, ...access.pendingKeys])],
    records,
    viewer,
    people: accessSnapshot.people,
    actorId,
    personal: personalState,
    lookup,
    timezone,
    locale,
    can,
    run,
    updatePersonal,
    remind,
    cancelReminder,
    processReminders,
    unavailable: resource.status === "error",
  };
}
export type BoardsController = ReturnType<typeof useBoardsController>;
export function boardCopyFields(board: Board): Board {
  return structuredClone(board);
}
