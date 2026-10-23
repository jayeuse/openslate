"use client";

import { DepartmentMark } from "@/components/sandbox/department-mark";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";

import { formatDateTime } from "../helpers/people";
import type { PersonMemberships } from "../hooks/use-people-memberships";
import type { AccessDirectoryUser } from "../state/api";
import { orderedDepartments, useDepartmentOrder } from "./people-row-parts";

function Recorded({ value, empty }: { value: string | null; empty: string }) {
  const region = useWorkspaceDisplayRegion();
  return value === null ? (
    <span className="text-muted-foreground">{empty}</span>
  ) : (
    <time dateTime={value} className="tabular-nums">
      {formatDateTime(value, region)}
    </time>
  );
}

/**
 * What the directory records about a person, read-only: the facts a 40px
 * People row leaves out (departments by name, recorded two-step status,
 * session count, last sign-in and last activity).
 */
export function PersonFacts({
  person,
  membership,
}: {
  person: AccessDirectoryUser;
  membership?: PersonMemberships;
}) {
  const position = useDepartmentOrder();
  const admin = person.role === "admin";
  const partial =
    membership !== undefined &&
    (membership.hasMore || membership.loaded < membership.total);
  const departments = orderedDepartments(
    membership?.departments ?? [],
    position,
  );
  return (
    <section aria-labelledby="person-facts-title" className="space-y-2">
      <h3 id="person-facts-title" className="font-semibold">
        Recorded activity
      </h3>
      <dl
        aria-label="Recorded activity"
        className="grid grid-cols-1 gap-y-1 text-sm md:grid-cols-[8rem_minmax(0,1fr)] md:gap-x-4 md:gap-y-2"
      >
        <dt className="text-muted-foreground">Departments</dt>
        <dd className="mb-2 min-w-0 md:mb-0">
          {admin ? (
            "All departments"
          ) : !membership || membership.loading ? (
            <span className="text-muted-foreground">Loading departments…</span>
          ) : departments.length ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {departments.map((department) => (
                <span
                  key={department.id}
                  className="inline-flex min-w-0 items-center gap-1.5"
                >
                  {department.index === null ? null : (
                    <DepartmentMark departmentIndex={department.index} />
                  )}
                  <span className="wrap-anywhere">{department.name}</span>
                </span>
              ))}
            </span>
          ) : partial ? null : (
            <span className="text-muted-foreground">None</span>
          )}
          {!admin && partial ? (
            <span className="text-muted-foreground block text-xs">
              Departments not fully loaded
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Two-step verification</dt>
        <dd className="mb-2 min-w-0 md:mb-0">
          {person.mfa_verified_totp === null
            ? "Unknown"
            : person.mfa_verified_totp
              ? "On"
              : "Off"}
          {person.mfa_observed_at ? (
            <span className="text-muted-foreground block text-xs">
              Recorded <Recorded value={person.mfa_observed_at} empty="" />
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Active sessions</dt>
        <dd className="mb-2 tabular-nums md:mb-0">
          {person.active_session_count}
        </dd>
        <dt className="text-muted-foreground">Last sign-in</dt>
        <dd className="mb-2 md:mb-0">
          <Recorded
            value={person.last_sign_in_at}
            empty="No recorded sign-in"
          />
        </dd>
        <dt className="text-muted-foreground">Last activity</dt>
        <dd>
          <Recorded
            value={person.last_active_at}
            empty="No recorded activity"
          />
        </dd>
      </dl>
    </section>
  );
}
