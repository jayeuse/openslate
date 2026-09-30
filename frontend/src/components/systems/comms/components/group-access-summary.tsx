"use client";

import {
  COMMS_GROUPS,
  EVERYONE_GROUP_ID,
  channelGroupAccess,
  commsGroup,
} from "../domain/groups";
import type { Category, Channel, GroupAccessLevel } from "../domain/model";
import { Action } from "../../shared/components/ui";
import { GroupMark } from "./group-mark";

const LEVEL_LABEL: Record<GroupAccessLevel, string> = {
  none: "No access",
  read: "Read",
  post: "Read and post",
};

/**
 * The Permissions tab starts from groups: who can use this place, in the
 * same words as Who can use. Role and person exceptions sit below it.
 */
export function GroupAccessSummary({
  scope,
  channel,
  category,
  categories,
  onChangeGroups,
}: {
  scope: "workspace" | "category" | "channel";
  channel?: Channel;
  category?: Category;
  categories: Category[];
  onChangeGroups?: () => void;
}) {
  const rows =
    scope === "channel" && channel
      ? (() => {
          const access = channelGroupAccess(channel, categories);
          const everyone = access[EVERYONE_GROUP_ID] ?? "none";
          return [
            {
              id: EVERYONE_GROUP_ID,
              name: "Everyone",
              tone: 0 as const,
              level: everyone,
            },
            ...COMMS_GROUPS.map((group) => ({
              ...group,
              level:
                everyone === "post" || access[group.id] === "post"
                  ? ("post" as const)
                  : everyone === "read" || access[group.id] === "read"
                    ? ("read" as const)
                    : ("none" as const),
            })),
          ];
        })()
      : [];
  const categoryGroup = commsGroup(category?.groupId);
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">Access by group</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {scope === "channel"
            ? "Who can use this channel. Groups are shown but not enforced yet; the exceptions below are what OpenComms applies today."
            : scope === "category"
              ? categoryGroup
                ? `This category belongs to the ${categoryGroup.name} group. New channels here start with that group.`
                : "This category is open to everyone. Choose a group on Overview to limit it."
              : "Every category and channel starts from its group. Set a category's group in its settings."}
        </p>
      </div>
      {rows.length > 0 && (
        <ul
          aria-label="Access by group"
          className="border-card-edge overflow-hidden rounded-[calc(var(--radius)*1.25)] border"
        >
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0"
            >
              <span className="flex items-center gap-2 font-medium">
                <GroupMark tone={row.tone} />
                {row.name}
              </span>
              <span
                className={
                  row.level === "none"
                    ? "text-muted-foreground"
                    : "text-foreground font-semibold"
                }
              >
                {LEVEL_LABEL[row.level]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {onChangeGroups && (
        <Action type="button" className="self-start" onClick={onChangeGroups}>
          Change who can use this {scope}
        </Action>
      )}
    </section>
  );
}
