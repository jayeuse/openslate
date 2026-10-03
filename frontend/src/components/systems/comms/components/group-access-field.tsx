"use client";

import { cn } from "@/lib/utils";
import type { Person } from "../../shared/data/sample-people";
import {
  COMMS_GROUPS,
  EVERYONE_GROUP_ID,
  channelGroupAccess,
  groupMembers,
  type GroupTone,
} from "../domain/groups";
import type { Category, Channel, GroupAccessLevel } from "../domain/model";
import { GroupMark } from "./group-mark";

const LEVELS: { value: GroupAccessLevel; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "read", label: "Read" },
  { value: "post", label: "Read and post" },
];

/** Who can use a channel, chosen per access group in plain words. */
export function GroupAccessField({
  channel,
  categories,
  people,
  onChange,
}: {
  channel: Channel;
  categories: Category[];
  people: Person[];
  onChange: (access: Record<string, GroupAccessLevel>) => void;
}) {
  const access = channelGroupAccess(channel, categories);
  const everyoneLevel = access[EVERYONE_GROUP_ID] ?? "none";
  // Everyone comes first: a group can add access, never have less than it.
  const rows: {
    id: string;
    name: string;
    tone: GroupTone;
    note: string;
    floor: GroupAccessLevel;
  }[] = [
    {
      id: EVERYONE_GROUP_ID,
      name: "Everyone",
      tone: 0,
      note: "Including guests, who can only read",
      floor: "none",
    },
    ...COMMS_GROUPS.map((group) => ({
      ...group,
      note: peopleCount(groupMembers(group.id, people).length),
      floor: everyoneLevel,
    })),
  ];
  const everyone = groupMembers(EVERYONE_GROUP_ID, people);
  const reach = (level: GroupAccessLevel) =>
    (access[EVERYONE_GROUP_ID] ?? "none") === level
      ? everyone
      : everyone.filter((person) =>
          COMMS_GROUPS.some(
            (group) =>
              access[group.id] === level &&
              person.departments.includes(group.id),
          ),
        );
  const posters = new Set(reach("post").map((person) => person.id));
  const readers = reach("read").filter((person) => !posters.has(person.id));
  const name = channel.name.trim() || "this channel";
  const floorNoteId = `group-access-floor-${channel.id}`;
  function choose(rowId: string, level: GroupAccessLevel) {
    if (rowId !== EVERYONE_GROUP_ID) {
      onChange({ ...access, [rowId]: level });
      return;
    }
    // Keep what each group can do now, so lowering Everyone never quietly
    // takes access away from a group.
    onChange({
      ...Object.fromEntries(
        COMMS_GROUPS.map((group) => [
          group.id,
          higher(access[group.id] ?? "none", everyoneLevel),
        ]),
      ),
      [EVERYONE_GROUP_ID]: level,
    });
  }
  return (
    <fieldset
      id={`who-can-use-${channel.id}`}
      tabIndex={-1}
      className="flex scroll-mt-4 flex-col gap-3 outline-none"
    >
      <legend className="mb-1 text-sm font-semibold">
        Who can use {name.startsWith("this") ? name : `#${name}`}
      </legend>
      <p className="text-muted-foreground -mt-1 text-xs">
        Choose what each group may do. In this example, group access is shown in
        OpenComms but not enforced yet.
      </p>
      <div className="border-card-edge overflow-hidden rounded-[calc(var(--radius)*1.25)] border">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-3 py-2.5 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <GroupMark tone={row.tone} />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{row.name}</p>
                <p className="text-muted-foreground text-xs">{row.note}</p>
              </div>
            </div>
            <div
              role="radiogroup"
              aria-label={row.name}
              aria-describedby={
                row.id === EVERYONE_GROUP_ID ? undefined : floorNoteId
              }
              className="bg-muted inline-flex rounded-[var(--radius)] p-0.5 shadow-[inset_0_0_0_1px_var(--border)]"
            >
              {LEVELS.map((level) => (
                <label
                  key={level.value}
                  className={cn(
                    "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
                    "text-muted-foreground has-[:focus-visible]:outline-ring flex min-h-9 cursor-pointer items-center rounded-[calc(var(--radius)*0.75)] px-2.5 text-xs font-medium has-[:focus-visible]:outline-2",
                    "has-[:checked]:bg-popover has-[:checked]:text-action-text has-[:checked]:font-semibold has-[:checked]:shadow-[var(--lift),inset_0_0_0_1px_var(--border)]",
                  )}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`group-access-${channel.id}-${row.id}`}
                    value={level.value}
                    checked={
                      higher(access[row.id] ?? "none", row.floor) ===
                      level.value
                    }
                    disabled={RANK[level.value] < RANK[row.floor]}
                    onChange={() => choose(row.id, level.value)}
                  />
                  {level.label}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p id={floorNoteId} className="text-muted-foreground -mt-1 text-xs">
        A group cannot have less access than Everyone. To limit a group, lower
        Everyone first.
      </p>
      <p className="bg-muted rounded-[var(--radius)] px-3 py-2 text-sm shadow-[inset_0_0_0_1px_var(--border)]">
        {everyoneLevel === "post" ? (
          <strong className="text-foreground font-semibold">
            Everyone can post here.
          </strong>
        ) : (
          <>
            <strong className="text-foreground font-semibold">
              {posters.size
                ? `${peopleCount(posters.size)} can post here`
                : "Nobody can post here"}
            </strong>
            {everyoneLevel === "read"
              ? ", and everyone else can read."
              : readers.length
                ? `, and ${readers.length} more can read.`
                : ". Nobody else can open it."}
          </>
        )}
      </p>
    </fieldset>
  );
}

const RANK: Record<GroupAccessLevel, number> = { none: 0, read: 1, post: 2 };
function higher(a: GroupAccessLevel, b: GroupAccessLevel): GroupAccessLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

function peopleCount(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}
