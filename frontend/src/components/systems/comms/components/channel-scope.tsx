"use client";
import Link from "next/link";
import { useEffect, useId, type MouseEvent, type ReactNode } from "react";
import { Building2, Check, Lock, Network } from "lucide-react";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { Action, Choice } from "../../shared/components/ui";
import { useCommsClient } from "../state/client-context";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { useCommsRead } from "../state/runtime";
import {
  creationLocked,
  departmentPlacement,
  grantReach,
} from "../domain/channel-creation";
import type { Category, Channel } from "../domain/view-model";

type Scope = Channel["scope"];

/** Who can use each kind of channel, in the words the dialog and Access tab share. */
export const SCOPE_COPY: Record<Scope, { title: string; description: string }> =
  {
    organization: {
      title: "Organization",
      description: "Everyone in the organization can post. Guests can read.",
    },
    department: {
      title: "Department",
      description:
        "People with a role in the department can read, post or manage, by their role.",
    },
  };

const ORGANIZATION_REASON = "Only admins can create organization channels.";
const NO_DEPARTMENT_REASON = "You cannot create channels in any department.";

/** Where a new department channel may go: any category of it (or none), only some, or nowhere. */
export type Placement = (departmentId: string) => "any" | string[] | null;

/**
 * The departments a viewer may put a new channel in, and where in each: an
 * admin anywhere; a department manager in managed departments unless a
 * workspace lock is on; a createChannel grant only in departments where the
 * viewer holds a role, and a category grant only in that category.
 */
export function useChannelDepartments() {
  const {
    catalog,
    managedDepartmentIds,
    departmentRoleIds,
    requestDepartments,
    retryDepartments,
    departmentsStatus,
  } = useCommsClient();
  const { checks, categories } = useCommsWorkspaceView();
  useEffect(() => {
    requestDepartments?.();
  }, [requestDepartments]);
  const admin = managedDepartmentIds === "all";
  const creation = useCommsRead(
    "channel-creation:workspace",
    (client, signal) =>
      client.getChannelCreationCheck({ kind: "workspace" }, { signal }),
  );
  // Per-category checks show category grants, which no channel check names.
  const candidates = admin
    ? []
    : categories
        .filter(
          (category) =>
            category.departmentId &&
            departmentRoleIds.has(category.departmentId),
        )
        .map((category) => category.id)
        .sort();
  const categoryChecks = useCommsRead(
    `channel-creation:categories:${candidates.join(",")}`,
    (client, signal) =>
      Promise.all(
        candidates.map(async (categoryId) => ({
          categoryId,
          check: await client.getChannelCreationCheck(
            { kind: "category", id: categoryId },
            { signal },
          ),
        })),
      ),
    candidates.length > 0,
  );
  const reach = grantReach(Object.values(checks), categoryChecks.data ?? []);
  const placement: Placement = (departmentId) =>
    departmentPlacement(departmentId, {
      admin,
      locked: creationLocked(creation.data),
      managed: managedDepartmentIds,
      roles: departmentRoleIds,
      reach,
      categories,
    });
  const failed =
    departmentsStatus === "error" ||
    !!creation.error ||
    (candidates.length > 0 && !!categoryChecks.error);
  const loading =
    (departmentsStatus ?? "ready") === "loading" ||
    (!admin && !creation.data) ||
    (candidates.length > 0 && !categoryChecks.data);
  return {
    admin,
    status: failed ? "error" : loading ? "loading" : "ready",
    options: catalog.departments.filter(
      (department) => placement(department.id) !== null,
    ),
    placement,
    retry: () => {
      if (departmentsStatus === "error") retryDepartments?.();
      if (creation.error) creation.reload();
      if (categoryChecks.error) categoryChecks.reload();
    },
  } as const;
}

/**
 * A new channel's starting scope: a non-admin can only create a department
 * channel, and a department channel with one possible department starts in it.
 */
export function withDefaultDepartment(
  channel: Channel,
  options: { id: string }[],
  admin = true,
): Channel {
  const scoped: Channel =
    !admin && channel.scope === "organization"
      ? { ...channel, scope: "department", departmentId: "" }
      : channel;
  return scoped.scope === "department" &&
    !scoped.departmentId &&
    options.length === 1
    ? { ...scoped, departmentId: options[0].id }
    : scoped;
}

/** Categories that may hold this channel: a department's own, or the unbound ones. */
export function compatibleCategories(channel: Channel, categories: Category[]) {
  return categories.filter((category) =>
    channel.scope === "department"
      ? !!channel.departmentId && category.departmentId === channel.departmentId
      : category.departmentId === "",
  );
}

/**
 * The categories a new channel may be created in, and whether "No category"
 * is one of them (a category grant alone requires its category).
 */
export function creationCategories(
  channel: Channel,
  categories: Category[],
  placement: Placement,
): { categories: Category[]; noCategory: boolean } {
  const compatible = compatibleCategories(channel, categories);
  if (channel.scope !== "department" || !channel.departmentId)
    return { categories: compatible, noCategory: true };
  const place = placement(channel.departmentId);
  return place === null || place === "any"
    ? { categories: compatible, noCategory: true }
    : {
        categories: compatible.filter((item) => place.includes(item.id)),
        noCategory: false,
      };
}

/** Why a category cannot hold the channel, in one plain sentence. */
export function categoryNote(
  category: Category,
  channel: Channel,
  departments: { id: string; name: string }[],
) {
  const holds = category.departmentId
    ? (departments.find((item) => item.id === category.departmentId)?.name ??
      "another department's")
    : "organization";
  return category.departmentId ===
    (channel.scope === "department" ? channel.departmentId : "")
    ? `You cannot create channels in ${category.name}.`
    : `${category.name} is for ${holds} channels only.`;
}

/** A department name with its Sandbox color beside it; the name always stays as text. */
export function DepartmentName({ id }: { id: string }) {
  const { catalog } = useCommsClient();
  const index = catalog.departments.findIndex(
    (department) => department.id === id,
  );
  const department = catalog.departments[index];
  if (!department) return <span>a department</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <DepartmentMark departmentIndex={index} />
      <bdi className="truncate">{department.name}</bdi>
    </span>
  );
}

/** "Organization" or "Department · Sales", for compact places like the header. */
export function ScopeLabel({ channel }: { channel: Channel }) {
  return channel.scope === "department" ? (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="shrink-0">Department ·</span>{" "}
      <DepartmentName id={channel.departmentId} />
    </span>
  ) : (
    <span>Organization</span>
  );
}

/**
 * The scope choice of a new channel. Two described choices are radio cards,
 * not a select; the department select appears only for Department.
 */
export function ChannelScopeChoice({
  channel,
  categories,
  departmentError,
  departmentErrorId,
  onChange,
}: {
  channel: Channel;
  categories: Category[];
  departmentError: string;
  departmentErrorId: string;
  onChange: (next: Channel, note: string) => void;
}) {
  const { catalog } = useCommsClient();
  const { admin, status, options, placement, retry } = useChannelDepartments();
  const legendId = useId();
  const ids = {
    organization: { title: useId(), note: useId(), reason: useId() },
    department: { title: useId(), note: useId(), reason: useId() },
  };
  const departmentDisabled = status === "ready" && options.length === 0;
  function choose(next: Channel) {
    const category = categories.find((item) => item.id === next.categoryId);
    const fits =
      !category ||
      creationCategories(next, categories, placement).categories.some(
        (item) => item.id === category.id,
      );
    onChange(
      fits ? next : { ...next, categoryId: "" },
      fits || !category
        ? ""
        : categoryNote(category, next, catalog.departments),
    );
  }
  const cards: {
    scope: Scope;
    Icon: typeof Building2;
    reason: string | null;
  }[] = [
    {
      scope: "organization",
      Icon: Building2,
      reason: admin ? null : ORGANIZATION_REASON,
    },
    {
      scope: "department",
      Icon: Network,
      reason: departmentDisabled ? NO_DEPARTMENT_REASON : null,
    },
  ];
  // A non-admin can only choose Department; on a phone it comes first so the
  // selected card shows without scrolling.
  if (!admin) cards.reverse();
  return (
    <div className="flex flex-col gap-3">
      <p id={legendId} className="text-sm font-medium">
        Who can use this channel
      </p>
      <RadioGroup
        aria-labelledby={legendId}
        value={channel.scope}
        onValueChange={(value) => {
          if (value === "organization" && admin)
            choose({ ...channel, scope: "organization", departmentId: "" });
          else if (value === "department" && !departmentDisabled)
            choose(
              withDefaultDepartment(
                { ...channel, scope: "department", departmentId: "" },
                options,
              ),
            );
        }}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {cards.map(({ scope, Icon, reason }) => {
          const selected = channel.scope === scope;
          const Mark = reason ? Lock : Check;
          return (
            <div key={scope} className="flex flex-col gap-1">
              <DisabledReason reason={reason} reasonId={ids[scope].reason}>
                <RadioGroupItem
                  value={scope}
                  aria-labelledby={ids[scope].title}
                  aria-describedby={ids[scope].note}
                  className={cn(
                    "h-auto min-h-11 w-full items-start justify-start gap-3 rounded-md border p-3 text-left",
                    selected
                      ? "border-primary bg-action-tint text-action-text"
                      : "border-border text-foreground hover:bg-muted",
                    reason &&
                      "text-muted-foreground cursor-not-allowed hover:bg-transparent",
                  )}
                >
                  <Icon size={18} aria-hidden="true" className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      id={ids[scope].title}
                      className="text-sm font-semibold"
                    >
                      {SCOPE_COPY[scope].title}
                    </span>
                    <span
                      id={ids[scope].note}
                      className="text-muted-foreground text-sm font-normal"
                    >
                      {SCOPE_COPY[scope].description}
                    </span>
                  </span>
                  <Mark
                    size={15}
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5",
                      !selected && !reason && "invisible",
                    )}
                  />
                </RadioGroupItem>
              </DisabledReason>
              {reason && (
                <p
                  id={ids[scope].reason}
                  className="text-muted-foreground px-1 text-xs"
                >
                  {reason}
                </p>
              )}
            </div>
          );
        })}
      </RadioGroup>
      {channel.scope === "department" && (
        <>
          <Choice
            label="Department"
            value={channel.departmentId}
            disabled={status !== "ready"}
            aria-invalid={!!departmentError}
            aria-describedby={departmentError ? departmentErrorId : undefined}
            onChange={(event) =>
              choose({ ...channel, departmentId: event.target.value })
            }
          >
            {status === "loading" ? (
              <NativeSelectOption value={channel.departmentId}>
                Loading departments…
              </NativeSelectOption>
            ) : status === "error" ? (
              <NativeSelectOption value={channel.departmentId}>
                Departments could not be loaded
              </NativeSelectOption>
            ) : (
              <>
                {options.length !== 1 && (
                  <NativeSelectOption value="">
                    Choose a department
                  </NativeSelectOption>
                )}
                {options.map((department) => (
                  <NativeSelectOption key={department.id} value={department.id}>
                    {department.name}
                  </NativeSelectOption>
                ))}
              </>
            )}
          </Choice>
          {status === "error" && (
            <Action
              type="button"
              variant="ghost"
              className="-mt-2 self-start px-2 underline underline-offset-4"
              onClick={retry}
            >
              Try again
            </Action>
          )}
          {departmentError && (
            <p
              id={departmentErrorId}
              role="alert"
              className="text-destructive -mt-2 text-sm"
            >
              {departmentError}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The departments a new category may belong to: an admin any department or
 * none, anyone else a department they manage.
 */
export function useCategoryDepartments() {
  const {
    catalog,
    managedDepartmentIds,
    requestDepartments,
    retryDepartments,
    departmentsStatus,
  } = useCommsClient();
  useEffect(() => {
    requestDepartments?.();
  }, [requestDepartments]);
  const admin = managedDepartmentIds === "all";
  return {
    admin,
    status: departmentsStatus ?? "ready",
    options: catalog.departments.filter(
      (department) => admin || managedDepartmentIds.has(department.id),
    ),
    retry: () => retryDepartments?.(),
  } as const;
}

/** A new category's department, chosen once; its channels then belong to it. */
export function CategoryDepartmentChoice({
  category,
  error,
  errorId,
  onChange,
}: {
  category: Category;
  error: string;
  errorId: string;
  onChange: (departmentId: string) => void;
}) {
  const { status, options, retry } = useCategoryDepartments();
  const noteId = useId();
  // Without a department a category holds organization channels; a member
  // who must choose one sees no note until they do.
  const note = category.departmentId ? (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
      Channels in this category belong to{" "}
      <DepartmentName id={category.departmentId} />
    </span>
  ) : (
    "Channels in this category are open to the whole organization."
  );
  return (
    <div className="flex flex-col gap-2">
      <Choice
        label="Department"
        value={category.departmentId}
        disabled={status !== "ready"}
        aria-invalid={!!error}
        aria-describedby={
          [note ? noteId : "", error ? errorId : ""]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(event) => onChange(event.target.value)}
      >
        {status === "loading" ? (
          <NativeSelectOption value={category.departmentId}>
            Loading departments…
          </NativeSelectOption>
        ) : status === "error" ? (
          <NativeSelectOption value={category.departmentId}>
            Departments could not be loaded
          </NativeSelectOption>
        ) : (
          <>
            <NativeSelectOption value="">No department</NativeSelectOption>
            {options.map((department) => (
              <NativeSelectOption key={department.id} value={department.id}>
                {department.name}
              </NativeSelectOption>
            ))}
          </>
        )}
      </Choice>
      {note && (
        <p id={noteId} className="text-muted-foreground -mt-1 text-sm">
          {note}
        </p>
      )}
      {status === "error" && (
        <Action
          type="button"
          variant="ghost"
          className="self-start px-2 underline underline-offset-4"
          onClick={retry}
        >
          Try again
        </Action>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/** A saved channel's scope: read-only text, visibly different from a disabled control. */
export function ChannelScopeSummary({ channel }: { channel: Channel }) {
  return (
    <div className="bg-muted max-w-prose rounded-lg px-3 py-2.5">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
        <span className="font-medium">Who can use this channel:</span>
        <ScopeLabel channel={channel} />
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        {SCOPE_COPY[channel.scope].description}
      </p>
    </div>
  );
}

const ORGANIZATION_ROWS: [string, string][] = [
  ["Members", "can post"],
  ["Guests", "can read"],
  ["Admins and channel managers", "can manage"],
];
const DEPARTMENT_ROWS: [string, string][] = [
  ["Read role", "can read"],
  ["Write role", "can post"],
  ["Manage role", "can manage this channel"],
  ["Admins", "manage every channel"],
];

function AccessRows({
  rows,
  label,
}: {
  rows: [string, string][];
  label: string;
}) {
  return (
    <dl
      aria-label={label}
      className="bg-muted grid max-w-prose grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg px-3 py-2.5 text-sm"
    >
      {rows.map(([subject, outcome]) => (
        <div key={subject} className="contents">
          <dt className="font-medium">{subject}</dt>
          <dd className="text-muted-foreground">{outcome}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Who can use a channel, a category's channels, or channels in general. Read
 * only: department roles change in Access → Groups, never inside Comms.
 */
export function AccessSummary({
  scope,
  channel,
  category,
  onNavigate,
}: {
  scope: "workspace" | "category" | "channel";
  channel?: Channel;
  category?: Category;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { managedDepartmentIds } = useCommsClient();
  const departmentId =
    scope === "channel"
      ? channel?.scope === "department"
        ? channel.departmentId
        : ""
      : scope === "category"
        ? (category?.departmentId ?? "")
        : "";
  const sections: { title: ReactNode; scope: Scope }[] =
    scope === "workspace"
      ? [
          { title: "Organization channels", scope: "organization" },
          { title: "Department channels", scope: "department" },
        ]
      : [
          {
            title: departmentId ? (
              <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
                {scope === "category"
                  ? "Channels in this category belong to"
                  : "This channel belongs to"}{" "}
                <DepartmentName id={departmentId} />
              </span>
            ) : scope === "category" ? (
              "Channels in this category are open to the whole organization."
            ) : (
              "This channel is open to the whole organization."
            ),
            scope: departmentId ? "department" : "organization",
          },
        ];
  return (
    <section aria-label="Who can use it" className="flex flex-col gap-4">
      {sections.map((section) => (
        <div key={section.scope} className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">{section.title}</h4>
          <AccessRows
            label={SCOPE_COPY[section.scope].title}
            rows={
              section.scope === "department"
                ? DEPARTMENT_ROWS
                : ORGANIZATION_ROWS
            }
          />
        </div>
      ))}
      {/* Department roles decide only department channels. */}
      {managedDepartmentIds === "all" &&
        sections.some((section) => section.scope === "department") && (
          <Link
            href="/access?view=groups"
            onClick={onNavigate}
            className="self-start text-sm underline underline-offset-4"
          >
            Change department roles in Access → Groups
          </Link>
        )}
    </section>
  );
}
