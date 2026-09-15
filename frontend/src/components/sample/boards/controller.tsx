"use client";

import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import {
  useAccessController,
  type AccessControllerState,
} from "../access/controller";
import {
  resolveControllerAccess,
  type AccessControllerSnapshot,
} from "../access/controller-utils";
import {
  getFederatedAccess,
  type FederatedAccessOwners,
} from "../access/federated-adapters";
import { departments } from "../access/model";
import {
  useSampleState,
  useSampleTransaction,
  type SampleTransactionDraft,
} from "../sample-state";
import { INITIAL_RECORDS, type SampleRecord } from "../sample-data";
import { releaseLocalAttachment } from "../comms/local-attachments";
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
  type BoardPersonalState,
  type Board,
} from "./model";
import {
  dueBoardReminders,
  getReminderDueAt,
  type BoardReminderTiming,
} from "./content";
import {
  executeBoardCommand,
  type BoardCommand,
  type BoardCommandContext,
  type BoardsState,
} from "./commands";

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
type RawState = Record<keyof BoardsState, unknown>;

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
function read<T>(draft: SampleTransactionDraft, key: string, initial: T): T {
  let value = initial;
  draft.update<T>(key, initial, (current) => {
    value = current;
    return current;
  });
  return value;
}
function lookupFrom(
  state: Pick<AccessControllerState, "roles" | "people">,
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
function readBoards(
  draft: SampleTransactionDraft,
  lookup: BoardAudienceLookup,
): BoardsState {
  return decodeBoardsState(
    Object.fromEntries(
      Object.entries(BOARD_KEYS).map(([key, storageKey]) => [
        key,
        read<unknown>(draft, storageKey, null),
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
function currentAccess(
  draft: SampleTransactionDraft,
  base: AccessControllerSnapshot,
): AccessControllerSnapshot {
  return {
    ...base,
    people: read(draft, "access-people", base.people),
    roles: read(draft, "access-roles", base.roles),
    rules: read(draft, "access-rules-v1", {
      version: 1,
      items: base.rules.filter((rule) => !rule.id.startsWith("native:")),
    }).items,
    groups: read(draft, "access-groups-v1", { version: 1, items: base.groups })
      .items,
    guests: read(draft, "access-guests-v1", { version: 1, items: base.guests })
      .items,
    services: read(draft, "access-services-v1", {
      version: 1,
      items: base.services,
    }).items,
    defaults: read(draft, "access-defaults-v1", {
      version: 1,
      value: base.defaults,
    }).value,
    deletedIdentities: read(draft, "access-deleted-identities-v1", {
      version: 1,
      items: base.deletedIdentities,
    }).items,
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

export function useBoardsController(previewIdentityId: string | null = null) {
  const access = useAccessController();
  const [boards] = useSampleState<unknown>(BOARD_KEYS.boards, null);
  const [events] = useSampleState<unknown>(BOARD_KEYS.events, null);
  const [announcements] = useSampleState<unknown>(
    BOARD_KEYS.announcements,
    null,
  );
  const [placements] = useSampleState<unknown>(BOARD_KEYS.placements, null);
  const [personal] = useSampleState<unknown>(BOARD_KEYS.personal, null);
  const [templates] = useSampleState<unknown>(BOARD_KEYS.templates, null);
  const [activity] = useSampleState<unknown>(BOARD_KEYS.activity, null);
  const [records] = useSampleState<SampleRecord[]>("records", INITIAL_RECORDS);
  const [settings] = useSampleState<Record<string, unknown>>(
    "manage-settings",
    {},
  );
  const transact = useSampleTransaction();
  const lookup = lookupFrom(access.state);
  const state = decodeBoardsState(
    {
      boards,
      events,
      announcements,
      placements,
      personal,
      templates,
      activity,
    },
    lookup,
  );
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
  const viewer = access.state.people.find((person) => person.id === actorId);
  const personalState =
    state.personal[actorId] ??
    decodeBoardPersonalState({ identityId: actorId });

  function contextFor(
    current: BoardsState,
    snapshot: AccessControllerSnapshot,
    now: string,
    id: string,
    preview = previewIdentityId !== null,
  ): BoardCommandContext {
    const policy = attachBoardsPolicy(snapshot, access.owners, current);
    return {
      actorId,
      preview,
      now,
      id,
      audienceLookup: lookupFrom(snapshot),
      recordIds: records.map((record) => record.id),
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
      access.state,
      new Date().toISOString(),
      "preview",
    ).can(boardId, permission);
  }
  function run(command: BoardCommand) {
    const now = new Date().toISOString();
    const id = `board-activity-${crypto.randomUUID()}`;
    const preview = executeBoardCommand(
      state,
      command,
      contextFor(state, access.state, now, id),
    );
    if (!preview.result.ok) return preview.result;
    let committed: ReturnType<typeof executeBoardCommand>["result"] = {
      ok: false,
      error:
        "The board could not be saved. Keep the editor open and try again.",
    };
    // Editors need the authoritative transaction outcome before closing.
    flushSync(() =>
      transact((draft) => {
        const snapshot = currentAccess(draft, access.state);
        const current = readBoards(draft, lookupFrom(snapshot));
        const result = executeBoardCommand(
          current,
          command,
          contextFor(current, snapshot, now, id),
        );
        committed = result.result;
        if (!committed.ok) return;
        for (const key of Object.keys(BOARD_KEYS) as (keyof BoardsState)[]) {
          if (
            JSON.stringify(current[key]) !== JSON.stringify(result.state[key])
          )
            draft.update<unknown>(BOARD_KEYS[key], null, result.state[key]);
        }
        if (command.type === "board-action" && command.action === "delete") {
          const scopeIds = new Set([
            `board:${command.boardId}`,
            ...(current.boards
              .find((board) => board.id === command.boardId)
              ?.widgets.map(
                (widget) =>
                  `openview:board-widget:${command.boardId}:${widget.id}`,
              ) ?? []),
          ]);
          draft.update(
            "access-rules-v1",
            { version: 1, items: snapshot.rules },
            (rules) => ({
              ...rules,
              items: rules.items.filter(
                (rule) =>
                  !scopeIds.has(rule.scope.id) &&
                  !rule.id.startsWith("native:"),
              ),
            }),
          );
        }
      }),
    );
    return committed;
  }
  function updatePersonal(patch: Partial<BoardPersonalState>) {
    return run({
      type: "personal",
      value: { ...personalState, ...patch, identityId: actorId },
    });
  }
  function remind(
    event: BoardsState["events"][number],
    timing: BoardReminderTiming,
    occurrenceStart: string,
  ) {
    if (previewIdentityId || !can(event.boardId, "view"))
      return {
        ok: false as const,
        error: "Reminders are unavailable in a read-only preview.",
      };
    let start = occurrenceStart;
    if (/^\d{4}-\d{2}-\d{2}$/.test(start))
      start = datetimeInputToUtc(`${start}T00:00`, event.timezone);
    const dueAt = getReminderDueAt({ start }, timing);
    const key = `${event.id}:${actorId}:${occurrenceStart}`;
    const reminder = {
      id: `board-reminder:${key}`,
      eventId: event.id,
      identityId: actorId,
      occurrenceStart,
      dueAt,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    };
    return updatePersonal({
      reminders: [
        ...personalState.reminders.filter((item) => item.id !== reminder.id),
        reminder,
      ],
    });
  }
  function processReminders(boardId: string) {
    if (previewIdentityId || !can(boardId, "view")) return;
    const now = new Date().toISOString();
    if (!dueBoardReminders(personalState.reminders, now).length) return;
    transact((draft) => {
      const current = readBoards(draft, lookup);
      const own = current.personal[actorId];
      if (!own) return;
      const due = dueBoardReminders(own.reminders, now).filter((reminder) =>
        current.events.some(
          (event) =>
            event.id === reminder.eventId &&
            event.boardId === boardId &&
            !event.archived,
        ),
      );
      if (!due.length) return;
      const ids = new Set(due.map((item) => item.id));
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
            (reminder) => !notices.some((notice) => notice.id === reminder.id),
          )
          .map((reminder) => {
            const event = current.events.find(
              (item) => item.id === reminder.eventId,
            );
            return {
              id: reminder.id,
              title: `Reminder: ${event?.title ?? "Board event"}`,
              recordId: event?.links.find((link) => link.recordId)?.recordId,
              read: false,
            };
          }),
        ...notices,
      ]);
    });
  }
  const unavailable = [boards, events, announcements].some(
    (value) => value !== null && !Array.isArray(value),
  );
  return {
    state,
    access,
    records,
    viewer,
    actorId,
    personal: personalState,
    lookup,
    timezone,
    locale,
    can,
    run,
    updatePersonal,
    remind,
    processReminders,
    unavailable,
  };
}
export type BoardsController = ReturnType<typeof useBoardsController>;
export function boardCopyFields(board: Board): Board {
  return structuredClone(board);
}
