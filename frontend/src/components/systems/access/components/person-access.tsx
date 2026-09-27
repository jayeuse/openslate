"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";

import {
  departmentListOptions,
  moduleListOptions,
  userAccessOptions,
} from "../adapters/access-queries";
import { presentAccess, type AccessRow } from "../helpers/people";
import type { AccessUser } from "../state/api";

// A person's effective access: per department and module, the level and the
// groups that give it. The backend decides it; this view only names it.

function AccessSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

function InactiveNote({ admin }: { admin: boolean }) {
  return (
    <Alert variant="warning" role="status">
      This account is not active, so it has no access now.{" "}
      {admin
        ? "Full access returns once it is active."
        : "Its groups apply again once it is active."}
    </Alert>
  );
}

function AccessEntry({ row }: { row: AccessRow }) {
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium break-words">{row.departmentName}</p>
        <p className="text-muted-foreground text-sm break-words">
          {row.moduleName ?? "All modules"}
        </p>
        <p className="text-muted-foreground mt-1 text-sm break-words">
          From{" "}
          {row.sources.length
            ? row.sources
                .map((source) => `${source.name} (${source.levelLabel})`)
                .join(", ")
            : "no group"}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Badge variant="secondary">{row.levelLabel}</Badge>
        {row.capped ? <Badge variant="outline">Guest limit</Badge> : null}
      </div>
    </li>
  );
}

export function PersonAccess({ person }: { person: AccessUser }) {
  const [now] = useState(() => Date.now());
  // The route refuses deleted people: they have no access to explain.
  const access = useQuery({
    ...userAccessOptions(person.id),
    enabled: !person.is_deleted,
  });
  const departments = useQuery(departmentListOptions("exclude"));
  const modules = useQuery(moduleListOptions("exclude"));
  const failed = access.isError || departments.isError || modules.isError;
  const loading =
    !failed && (access.isPending || departments.isPending || modules.isPending);
  const view =
    access.data && departments.data && modules.data
      ? presentAccess(access.data, person, departments.data, modules.data, now)
      : null;

  return (
    <section aria-labelledby="person-access-title" className="space-y-3">
      <div>
        <h3 id="person-access-title" className="font-semibold">
          Access
        </h3>
        <p className="text-muted-foreground text-sm">
          What this person can open, and the groups that give it.
        </p>
      </div>
      {person.is_deleted ? (
        <p className="text-muted-foreground rounded-lg border p-4 text-sm">
          Deleted people have no access. Restore this person to see it again.
        </p>
      ) : failed ? (
        <div role="alert" className="space-y-3 rounded-lg border p-4">
          <p className="text-sm">Access could not be loaded.</p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              if (access.isError) void access.refetch();
              if (departments.isError) void departments.refetch();
              if (modules.isError) void modules.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <LoadingRegion
          loading={loading}
          label="Loading access…"
          skeleton={<AccessSkeleton />}
        >
          {view?.kind === "full" ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border p-4">
                <ShieldCheck
                  aria-hidden="true"
                  className="text-muted-foreground mt-0.5 size-5 shrink-0"
                />
                <div>
                  <p className="font-medium">Full access</p>
                  <p className="text-muted-foreground text-sm">
                    Administrators can read, change, and manage everything in
                    every department.
                  </p>
                </div>
              </div>
              {view.inactive ? <InactiveNote admin /> : null}
            </div>
          ) : view?.kind === "entries" ? (
            <div className="space-y-3">
              {view.inactive ? <InactiveNote admin={false} /> : null}
              {view.guestCapped ? (
                <Alert role="status">
                  Guests can only read. Where a group gives more, this person
                  still gets Read.
                </Alert>
              ) : null}
              {view.rows.length ? (
                <ul
                  aria-label="Access by department"
                  className="divide-border divide-y rounded-lg border px-4"
                >
                  {view.rows.map((row) => (
                    <AccessEntry key={row.key} row={row} />
                  ))}
                </ul>
              ) : view.inactive ? null : (
                <p className="text-muted-foreground rounded-lg border p-4 text-sm">
                  No access yet. Add this person to a group on the Groups tab to
                  give them access.
                </p>
              )}
            </div>
          ) : null}
        </LoadingRegion>
      )}
    </section>
  );
}
