"use client";

import type { Route } from "next";
import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { SearchSelect } from "@/components/ui/search-select";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";

import { afterAccessGroupChange } from "../adapters/access-queries";
import { changeGroupMembership } from "../adapters/group-membership";
import {
  accessSummary,
  groupErrorMessage,
  summaryLabel,
} from "../helpers/groups";
import { isUnansweredRequest, personName } from "../helpers/people";
import type { PersonMemberships } from "../hooks/use-people-memberships";
import { catalogGroups, useAccessCatalog } from "../hooks/use-access-catalog";
import type { AccessUser } from "../state/api";
import { ActionError } from "./editor-conflicts";

const unanswered =
  "The change got no answer, so it may have completed. Check the list before you try again.";

/**
 * The person's groups, with Add to group and a Remove per row (decision A2,
 * the Access grants list pattern). Each change saves at once through the
 * same member-merge path as the group's Members tab, so a concurrent
 * Members change is kept. Only administrators open the person sheet, so
 * only they see these controls.
 */
export function PersonGroups({
  person,
  membership,
}: {
  person: AccessUser;
  membership?: PersonMemberships;
}) {
  const id = useId();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState("");
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState("");
  // Each row saves on its own; only the row being changed locks.
  const [removing, setRemoving] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const focusAdd = useRef(false);
  const mounted = useRef(false);
  const search = useAccessCatalog({ kind: "groups", enabled: adding });
  const name = personName(person);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!focusAdd.current || adding || addPending || removing.size) return;
    focusAdd.current = false;
    addButton.current?.focus();
  });

  if (person.role === "admin")
    return (
      <section aria-labelledby={`${id}-title`} className="space-y-2">
        <h3 id={`${id}-title`} className="font-semibold">
          Groups
        </h3>
        <p className="text-muted-foreground text-sm">
          Administrators have full access everywhere, so they are not members of
          groups.
        </p>
      </section>
    );

  const groups = membership?.groups ?? [];
  const listed =
    membership !== undefined &&
    !membership.loading &&
    !membership.denied &&
    !(membership.error && !groups.length);
  // A deleted person cannot join a group; restore them first.
  const editable = listed && !person.is_deleted;
  const options = catalogGroups(search.items).map((group) => {
    const member = group.member_ids.includes(person.id);
    const reach = accessSummary(group.access).map(summaryLabel).join(", ");
    return {
      value: group.id,
      label: group.name,
      group: "Groups",
      disabled: member,
      description: member ? "Already a member" : reach || "No access",
    };
  });
  const chosen = options.find((option) => option.value === choice);

  function closeAdd() {
    setAdding(false);
    setChoice("");
    setAddError("");
    focusAdd.current = true;
  }

  async function add() {
    if (!chosen || chosen.disabled || addPending) return;
    setAddPending(true);
    setAddError("");
    try {
      const result = await changeGroupMembership(chosen.value, person.id, true);
      await afterAccessGroupChange(client);
      if (!mounted.current) return;
      setAnnouncement(
        result === "changed"
          ? `${name} added to ${chosen.label}.`
          : `${name} is already in ${chosen.label}.`,
      );
      closeAdd();
    } catch (caught) {
      if (!mounted.current) return;
      setAddError(
        isUnansweredRequest(caught)
          ? unanswered
          : groupErrorMessage(
              caught,
              "The person could not be added. Try again.",
            ),
      );
      void afterAccessGroupChange(client);
    } finally {
      if (mounted.current) setAddPending(false);
    }
  }

  async function remove(groupId: string, groupName: string) {
    if (removing.has(groupId)) return;
    setRemoving((current) => new Set([...current, groupId]));
    setRowErrors((current) => ({ ...current, [groupId]: "" }));
    try {
      await changeGroupMembership(groupId, person.id, false);
      await afterAccessGroupChange(client);
      if (!mounted.current) return;
      setAnnouncement(`${name} removed from ${groupName}.`);
      focusAdd.current = true;
    } catch (caught) {
      if (!mounted.current) return;
      setRowErrors((current) => ({
        ...current,
        [groupId]: isUnansweredRequest(caught)
          ? unanswered
          : groupErrorMessage(
              caught,
              "The person could not be removed. Try again.",
            ),
      }));
      void afterAccessGroupChange(client);
    } finally {
      if (mounted.current)
        setRemoving(
          (current) =>
            new Set([...current].filter((value) => value !== groupId)),
        );
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2">
      <h3 id={`${id}-title`} className="font-semibold">
        Groups
      </h3>
      {!membership || membership.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading groups…
        </p>
      ) : !listed ? null : groups.length ? (
        <ul
          aria-label="Groups"
          className="divide-border divide-y rounded-lg border"
        >
          {groups.map((group) => {
            const busy = removing.has(group.id);
            const rowError = rowErrors[group.id];
            return (
              <li
                key={group.id}
                aria-busy={busy || undefined}
                className="flex min-w-0 flex-col gap-1 px-3 py-1.5"
              >
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <GuardedWorkspaceLink
                      href={
                        `/access?view=groups&group=${encodeURIComponent(group.id)}&tab=members` as Route
                      }
                      className="focus-visible:outline-ring block min-w-0 truncate rounded-sm py-3 text-sm font-medium underline decoration-[var(--rule-strong)] underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 xl:py-0"
                    >
                      {group.name}
                    </GuardedWorkspaceLink>
                    {busy ? (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        · Saving…
                      </span>
                    ) : null}
                  </span>
                  {editable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 shrink-0 px-2"
                      aria-label={`Remove from ${group.name}`}
                      pending={busy}
                      onClick={() => void remove(group.id, group.name)}
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
                {rowError ? (
                  <p role="alert" className="text-danger-text text-sm">
                    {rowError}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          Not in any group yet, so this person has no access.
        </p>
      )}
      {membership && listed ? (
        <>
          {membership.hasMore || membership.loaded < membership.total ? (
            <p className="text-muted-foreground text-sm">
              {membership.loaded} of {membership.total} groups
            </p>
          ) : null}
        </>
      ) : null}
      {membership?.error ? (
        <p role="alert" className="text-danger-text text-sm">
          {membership.error}
        </p>
      ) : null}
      {membership?.retryFirstPage ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={membership.recovering}
          onClick={() => void membership.retry()}
        >
          Retry groups
        </Button>
      ) : null}
      {membership?.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={membership.loadingMore}
          onClick={() => void membership.loadMore()}
        >
          {membership.loadingMore ? "Loading more groups…" : "Load more groups"}
        </Button>
      ) : null}
      {editable && adding ? (
        <div
          role="group"
          aria-label="Add to group"
          data-slim-well="surface"
          className="bg-muted space-y-3 rounded-lg p-3"
        >
          <SearchSelect
            id={`${id}-group`}
            popupClassName="slim-ui"
            label="Group"
            value={choice}
            options={options}
            onValueChange={(value) => {
              setChoice(value);
              setAddError("");
            }}
            search={search.search}
            onSearchChange={search.onSearchChange}
            loading={search.loading}
            error={search.error}
            onRetry={() => void search.retry()}
            hasMore={search.hasMore}
            onLoadMore={() => void search.loadMore()}
            loadingMore={search.loadingMore}
            disabled={addPending}
            placeholder="Choose a group"
            searchPlaceholder="Search groups"
            emptyMessage={
              search.search ? "No groups match." : "There are no groups yet."
            }
          />
          <ActionError message={addError} title={null} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={addPending}
              onClick={closeAdd}
            >
              Cancel
            </Button>
            <DisabledReason
              reason={
                !chosen || chosen.disabled ? "Choose a group first." : null
              }
            >
              <Button
                type="button"
                className="min-h-11"
                pending={addPending}
                pendingLabel="Adding…"
                onClick={() => void add()}
              >
                Add
              </Button>
            </DisabledReason>
          </div>
        </div>
      ) : editable ? (
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          onClick={() => {
            setAddError("");
            setAdding(true);
          }}
        >
          <Plus aria-hidden="true" />
          Add to group
        </Button>
      ) : null}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
