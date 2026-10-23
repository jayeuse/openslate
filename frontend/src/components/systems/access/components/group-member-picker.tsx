"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, UserRoundMinus, UserRoundPlus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  GROUP_MEMBER_LIMIT,
  memberOptionsFromUsers,
  memberOptionsFromCandidates,
  type MemberOption,
} from "../helpers/groups";
import { personName, roleLabels } from "../helpers/people";

import { usePeopleSearch } from "../hooks/use-people-search";
import type { AccessPeopleSource } from "../adapters/people-picker-queries";
import type { AccessDirectoryUser, AccessMemberCandidate } from "../state/api";

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
  source = "users",
  peopleSearch,
  selected,
  disabled,
  creating = false,
  onChange,
}: {
  source?: AccessPeopleSource;
  peopleSearch?: ReturnType<typeof usePeopleSearch>;
  selected: readonly string[];
  disabled: boolean;
  /** In Create group, Create adds the members; there is no Save members. */
  creating?: boolean;
  onChange: (memberIds: string[]) => void;
}) {
  const id = useId();
  const [now] = useState(() => Date.now());
  const localSearch = usePeopleSearch({
    source,
    selectedIds: selected,
    enabled: peopleSearch === undefined,
  });
  const remote = peopleSearch ?? localSearch;
  const known = [
    ...new Map(
      [...remote.items, ...remote.selectedItems].map((item) => [item.id, item]),
    ).values(),
  ];
  const options =
    source === "users"
      ? memberOptionsFromUsers(
          known.filter(
            (item): item is AccessDirectoryUser => "is_deleted" in item,
          ),
          now,
        )
      : memberOptionsFromCandidates(
          known.filter(
            (item): item is AccessMemberCandidate => "access_ends_at" in item,
          ),
          now,
        );
  for (const item of remote.selectedItems) {
    if ("is_deleted" in item && item.is_deleted && item.role !== "admin")
      options.push({
        id: item.id,
        name: personName(item),
        email: item.email,
        role: item.role,
        blocked: "Deleted",
        statusLabel: "Deleted",
      });
  }
  const query = remote.search;
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The member whose Remove button takes focus after a change; null is the
  // search, undefined is no request.
  const focusRequest = useRef<string | null | undefined>(undefined);
  const byId = new Map(options.map((option) => [option.id, option]));
  const members = selected
    .map(
      (memberId): MemberOption =>
        byId.get(memberId) ?? {
          id: memberId,
          name:
            source === "candidates" ? "Former member" : "Unavailable person",
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
  const visibleIds = new Set(remote.items.map((item) => item.id));
  const matches = options.filter(
    (option) => visibleIds.has(option.id) && !chosen.has(option.id),
  );
  const full = selected.length >= GROUP_MEMBER_LIMIT;
  const blockedMembers = members.filter((member) => member.blocked).length;

  // The pressed button leaves the page, so focus moves to where the person
  // is working: the search after an add, a neighbouring member after a remove.
  useEffect(() => {
    const memberId = focusRequest.current;
    if (memberId === undefined) return;
    focusRequest.current = undefined;
    const target = memberId
      ? listRef.current?.querySelector<HTMLButtonElement>(
          `[data-member-id="${CSS.escape(memberId)}"]`,
        )
      : null;
    (target ?? searchRef.current?.querySelector("input"))?.focus();
  });

  const saveHint = creating ? "" : " Save members to apply.";

  function add(option: MemberOption) {
    onChange([...selected, option.id]);
    setAnnouncement(`${option.name} added.${saveHint}`);
    focusRequest.current = null;
  }

  function remove(member: MemberOption) {
    const index = members.findIndex((item) => item.id === member.id);
    const neighbour = members[index + 1] ?? members[index - 1] ?? null;
    onChange(selected.filter((item) => item !== member.id));
    setAnnouncement(`${member.name} removed.${saveHint}`);
    focusRequest.current = neighbour?.id ?? null;
  }

  return (
    <div className="flex flex-col gap-5">
      <p role="status" className="sr-only">
        {announcement}
      </p>
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
          <ul
            ref={listRef}
            aria-label="Members"
            className="divide-y rounded-lg border"
          >
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
                  data-member-id={member.id}
                  disabled={disabled || remote.error !== ""}
                  onClick={() => remove(member)}
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
        <div ref={searchRef} className="relative">
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
            onChange={(event) => remote.onSearchChange(event.target.value)}
          />
        </div>
        {full ? (
          <p className="text-muted-foreground text-sm">
            A group can have up to {GROUP_MEMBER_LIMIT} members.
          </p>
        ) : null}
        {matches.length ? (
          <ul aria-label="People to add" className="divide-y rounded-lg border">
            {matches.map((option) => (
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
                  disabled={
                    disabled ||
                    full ||
                    option.blocked !== null ||
                    remote.error !== ""
                  }
                  onClick={() => add(option)}
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
        {remote.loading ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading people…
          </p>
        ) : null}
        {remote.error ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{remote.error}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={remote.retry}
            >
              Retry people
            </Button>
          </div>
        ) : null}
        {remote.hasMore ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={remote.loadingMore || remote.loading}
            onClick={() => void remote.loadMore()}
          >
            {remote.loadingMore ? "Loading more…" : "Load more people"}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
