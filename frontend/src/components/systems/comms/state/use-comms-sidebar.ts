"use client";
import type {
  CategoryPreferences,
  ConversationSummary,
  MemberPreferencesPatch,
} from "../contract/types";
import { useCommsWorkspaceView } from "./use-comms-workspace";
import { useCommsCommands, messageFromCommsError } from "./runtime";
import { reportCommsError } from "./comms-feedback";

export function muteActive(
  mute: CategoryPreferences["mute"] | undefined,
  now = Date.now(),
) {
  return (
    mute?.kind === "indefinite" ||
    (mute?.kind === "until" && Date.parse(mute.until) > now)
  );
}
export const muteDurations = [
  "for 1 hour",
  "for 8 hours",
  "until tomorrow",
  "until turned back on",
] as const;
export async function muteFor(
  duration: (typeof muteDurations)[number],
  signal?: AbortSignal,
): Promise<CategoryPreferences["mute"]> {
  if (duration === "until turned back on") return { kind: "indefinite" };
  const until = new Date();
  if (duration === "until tomorrow") {
    const [
      { getWorkspaceCalendarSettings },
      { formatDateTimeLocal, datetimeInputToUtc },
      { shiftMoveDay },
    ] = await Promise.all([
      import("../../manage/adapters/workspace-api"),
      import("@/lib/date-time"),
      import("../../openview/domain/record-moves"),
    ]);
    const { timezone } = await getWorkspaceCalendarSettings(signal);
    const tomorrow = shiftMoveDay(
      formatDateTimeLocal(until.toISOString(), timezone).slice(0, 10),
      1,
    );
    return {
      kind: "until",
      until: datetimeInputToUtc(`${tomorrow}T00:00`, timezone),
    };
  } else
    until.setTime(
      until.getTime() + (duration === "for 1 hour" ? 1 : 8) * 3600000,
    );
  return { kind: "until", until: until.toISOString() };
}
export type SidebarRow = ConversationSummary & {
  name: string;
  muted: boolean;
  unread: boolean;
};
export const countLabel = (count: number) =>
  count >= 100 ? "99+" : String(count);
export function rowLabel(row: SidebarRow) {
  return [
    row.name,
    row.unread_count
      ? `${countLabel(row.unread_count)} unread`
      : row.preferences.manual_unread
        ? "marked unread"
        : "",
    row.mention_count
      ? `${countLabel(row.mention_count)} ${row.mention_count === 1 ? "mention" : "mentions"}`
      : "",
    row.muted ? "muted" : "",
    row.conversation.archived_at ? "archived" : "",
  ]
    .filter(Boolean)
    .join(", ");
}
export function useCommsSidebar() {
  const workspace = useCommsWorkspaceView();
  const categories = workspace.bootstrap?.categories ?? [];
  const rows: SidebarRow[] = (workspace.bootstrap?.conversations ?? [])
    .filter(
      (row) =>
        !workspace.directs.find((direct) => direct.id === row.conversation.id)
          ?.blocked,
    )
    .map((row) => ({
      ...row,
      name:
        row.conversation.kind === "direct"
          ? (workspace.directs.find(
              (direct) => direct.id === row.conversation.id,
            )?.user ?? "Direct conversation")
          : row.conversation.name || "Group conversation",
      unread: row.unread_count > 0 || row.preferences.manual_unread,
      muted:
        row.preferences.notify === "mute" ||
        muteActive(row.preferences.mute) ||
        (row.conversation.kind === "channel" &&
          muteActive(
            categories.find(
              (category) =>
                category.category.id ===
                ("category_id" in row.conversation
                  ? row.conversation.category_id
                  : null),
            )?.preferences.mute,
          )),
    }));
  const { run, isPending } = useCommsCommands();
  async function mute(
    id: string,
    duration: (typeof muteDurations)[number],
    target: "conversation" | "category",
  ) {
    try {
      await run(`mute:${id}`, async (client, signal) => {
        const value = await muteFor(duration, signal);
        if (target === "category") {
          const current = await client.getCategoryPreferences(id, { signal });
          await client.setCategoryPreferences(
            id,
            { ...current.data, mute: value },
            { signal, if_match: current.etag },
          );
        } else {
          const current = await client.getMemberPreferences(id, { signal });
          await client.updateMemberPreferences(
            id,
            { mute: value },
            { signal, if_match: current.etag },
          );
        }
      });
    } catch (error) {
      reportCommsError(
        messageFromCommsError(error, "The mute could not be saved. Try again."),
      );
    }
  }
  async function change(id: string, patch: MemberPreferencesPatch) {
    try {
      await run(`sidebar:${id}`, async (client, signal) => {
        const current = await client.getMemberPreferences(id, { signal });
        await client.updateMemberPreferences(id, patch, {
          signal,
          if_match: current.etag,
        });
      });
    } catch (error) {
      reportCommsError(
        messageFromCommsError(
          error,
          "Conversation preferences could not be saved.",
        ),
      );
    }
  }
  async function categoryChange(
    id: string,
    patch: Partial<CategoryPreferences>,
  ) {
    try {
      await run(`category-preferences:${id}`, async (client, signal) => {
        const current = await client.getCategoryPreferences(id, { signal });
        await client.setCategoryPreferences(
          id,
          { ...current.data, ...patch },
          { signal, if_match: current.etag },
        );
      });
    } catch (error) {
      reportCommsError(
        messageFromCommsError(
          error,
          "Category preferences could not be saved.",
        ),
      );
    }
  }
  async function mark(row: SidebarRow) {
    if (!row.unread)
      return change(row.conversation.id, { manual_unread: true });
    try {
      await run(`read:${row.conversation.id}`, (client, signal) =>
        client.markRead(
          row.conversation.id,
          { last_read_seq: row.high_water_seq },
          { signal },
        ),
      );
    } catch (error) {
      reportCommsError(
        messageFromCommsError(
          error,
          "The conversation could not be marked read.",
        ),
      );
    }
  }
  return { rows, categories, change, categoryChange, mute, mark, isPending };
}
export type SidebarActions = ReturnType<typeof useCommsSidebar>;
