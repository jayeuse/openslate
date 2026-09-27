"use client";

import { useId, useState } from "react";
import { Search, UserRoundMinus, UserRoundPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { GROUP_MEMBER_LIMIT, type MemberOption } from "../helpers/groups";
import { roleLabels } from "../helpers/people";

/** Only the first matches show; a search narrows the rest. */
const VISIBLE_MATCHES = 25;

function PersonLine({ option }: { option: MemberOption }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium break-words">{option.name}</p>
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="break-all">{option.email}</span>
        {option.role === "guest" ? (
          <Badge variant="secondary">{roleLabels.guest}</Badge>
        ) : null}
        {option.statusLabel ? (
          <Badge variant={option.blocked ? "outline" : "warning"}>
            {option.statusLabel}
          </Badge>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The members of a group and a search to add more. Administrators are never
 * offered: they have access everywhere. Disabled people and people whose
 * access ended cannot be added, and must be removed before a save.
 */
export function GroupMemberPicker({
  options,
  selected,
  disabled,
  onChange,
}: {
  options: readonly MemberOption[];
  selected: readonly string[];
  disabled: boolean;
  onChange: (memberIds: string[]) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const byId = new Map(options.map((option) => [option.id, option]));
  const members = selected
    .map(
      (memberId): MemberOption =>
        byId.get(memberId) ?? {
          id: memberId,
          name: "Unavailable person",
          email: "No longer in the directory",
          role: "member",
          blocked: "Unavailable",
          statusLabel: "Unavailable",
        },
    )
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
  const chosen = new Set(selected);
  const needle = query.trim().toLocaleLowerCase();
  const matches = options.filter(
    (option) =>
      !chosen.has(option.id) &&
      (!needle ||
        `${option.name}\n${option.email}`.toLocaleLowerCase().includes(needle)),
  );
  const full = selected.length >= GROUP_MEMBER_LIMIT;
  const blockedMembers = members.filter((member) => member.blocked).length;

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby={`${id}-members`} className="space-y-2">
        <h3 id={`${id}-members`} className="text-sm font-semibold">
          In this group ({selected.length})
        </h3>
        {blockedMembers ? (
          <p className="text-muted-foreground text-sm">
            Remove people who are disabled, unavailable, or whose access ended
            before you save.
          </p>
        ) : null}
        {members.length ? (
          <ul aria-label="Members" className="divide-y rounded-lg border">
            {members.map((member) => (
              <li
                key={member.id}
                className="flex min-w-0 items-center gap-3 px-3 py-2"
              >
                <PersonLine option={member} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`Remove ${member.name}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(selected.filter((item) => item !== member.id))
                  }
                >
                  <UserRoundMinus aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground rounded-lg border p-4 text-sm">
            No one is in this group yet.
          </p>
        )}
      </section>

      <section aria-labelledby={`${id}-add`} className="space-y-2">
        <h3 id={`${id}-add`} className="text-sm font-semibold">
          Add people
        </h3>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            aria-label="Search people to add"
            placeholder="Name or email"
            className="min-h-11 pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {full ? (
          <p className="text-muted-foreground text-sm">
            A group can have up to {GROUP_MEMBER_LIMIT} members.
          </p>
        ) : null}
        {matches.length ? (
          <ul aria-label="People to add" className="divide-y rounded-lg border">
            {matches.slice(0, VISIBLE_MATCHES).map((option) => (
              <li
                key={option.id}
                className="flex min-w-0 items-center gap-3 px-3 py-2"
              >
                <PersonLine option={option} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`Add ${option.name}`}
                  disabled={disabled || full || option.blocked !== null}
                  onClick={() => onChange([...selected, option.id])}
                >
                  <UserRoundPlus aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            {needle
              ? "No one else matches."
              : "Everyone who can join is already in this group."}
          </p>
        )}
        {matches.length > VISIBLE_MATCHES ? (
          <p className="text-muted-foreground text-sm">
            {matches.length - VISIBLE_MATCHES} more. Search to find them.
          </p>
        ) : null}
      </section>
    </div>
  );
}
