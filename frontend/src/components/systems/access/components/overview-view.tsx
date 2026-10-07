"use client";

import {
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Route } from "next";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Clock3,
  KeyRound,
  MailQuestion,
  ShieldCheck,
  UserRoundX,
  UsersRound,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { ApiError } from "@/lib/api";

import {
  groupListOptions,
  userListOptions,
  userSummaryOptions,
} from "../adapters/access-queries";
import {
  EXPIRING_SOON_DAYS,
  formatDateTime,
  inactiveDaysError,
  parseInactiveDays,
} from "../helpers/people";
import {
  INACTIVE_DAYS_DEFAULT,
  INACTIVE_DAYS_MIN,
  INACTIVE_DAYS_MAX,
} from "../state/api-contracts";
import { overviewHealth, type OverviewHealth } from "../helpers/overview";
import { InvitationSettings } from "./invitation-settings";
import { TextField } from "./people-fields";

type HealthCard = {
  id: keyof OverviewHealth;
  title: string;
  icon: ReactNode;
  count: number;
  /** True when the count asks for attention. */
  attention: boolean;
  description: string;
  href: string;
  linkLabel: string;
};

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function healthCards(health: OverviewHealth): HealthCard[] {
  const icon = "size-4";
  return [
    {
      id: "administrators",
      title: "Administrators",
      icon: <ShieldCheck aria-hidden="true" className={icon} />,
      count: health.administrators,
      attention: health.administrators <= 1,
      description:
        health.administrators <= 1
          ? "If this person loses access, no one can change people or groups. Make a second person an administrator."
          : "Active people who can change people, groups, and settings.",
      href: "/access?view=people&role=admin&status=active",
      linkLabel: "Show administrators",
    },
    {
      id: "withoutGroup",
      title: "People without a group",
      icon: <UserRoundX aria-hidden="true" className={icon} />,
      count: health.withoutGroup,
      attention: health.withoutGroup > 0,
      description:
        "Members and guests in no group have no access to any department.",
      href: "/access?view=people&group=none",
      linkLabel: "Show these people",
    },
    {
      id: "groupsWithoutAccess",
      title: "Groups without access",
      icon: <KeyRound aria-hidden="true" className={icon} />,
      count: health.groupsWithoutAccess,
      attention: health.groupsWithoutAccess > 0,
      description:
        "Their members get nothing from them until you choose a level.",
      href: "/access?view=groups&filter=no-access",
      linkLabel: "Show these groups",
    },
    {
      id: "groupsWithoutMembers",
      title: "Groups without members",
      icon: <UsersRound aria-hidden="true" className={icon} />,
      count: health.groupsWithoutMembers,
      attention: health.groupsWithoutMembers > 0,
      description: "They give their access to no one.",
      href: "/access?view=groups&filter=no-members",
      linkLabel: "Show these groups",
    },
    {
      id: "guestsEndingSoon",
      title: "Access ending soon",
      icon: <Clock3 aria-hidden="true" className={icon} />,
      count: health.guestsEndingSoon,
      attention: health.guestsEndingSoon > 0,
      description: `Guests whose access ends within ${EXPIRING_SOON_DAYS} days.`,
      href: "/access?view=people&status=ending",
      linkLabel: "Show these guests",
    },
    {
      id: "pendingInvitations",
      title: "Pending invitations",
      icon: <MailQuestion aria-hidden="true" className={icon} />,
      count: health.pendingInvitations,
      attention: false,
      description: `${plural(health.pendingInvitations, "Invitation", "Invitations")} sent and not accepted yet.`,
      href: "/access?view=people&status=pending",
      linkLabel: "Show invitations",
    },
  ];
}

function HealthSkeleton() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <li key={index} className="space-y-3 rounded-lg border p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-12" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-11 w-36" />
        </li>
      ))}
    </ul>
  );
}

/**
 * The administrator's overview: what needs attention in people and groups,
 * each linked to the filtered list, and the invitation settings.
 */
export function OverviewView() {
  const settingsTitleId = useId();
  const users = useQuery(userListOptions("include"));
  const groups = useQuery(groupListOptions("exclude"));
  const [inactiveDays, setInactiveDays] = useState(INACTIVE_DAYS_DEFAULT);
  const [inactiveDraft, setInactiveDraft] = useState(
    String(INACTIVE_DAYS_DEFAULT),
  );
  const [inactiveError, setInactiveError] = useState<string | null>(null);
  const summary = useQuery(userSummaryOptions(inactiveDays));
  const [now] = useState(() => Date.now());
  const health = useMemo(
    () =>
      users.data && groups.data
        ? overviewHealth(users.data, groups.data, now)
        : null,
    [groups.data, now, users.data],
  );

  const denied = [users.error, groups.error, summary.error].some(
    (error) => error instanceof ApiError && error.status === 403,
  );
  const failed = users.isError || groups.isError;
  const historyCards = [
    {
      id: "sign-in",
      title: "No recorded sign-in",
      count: summary.data?.no_recorded_sign_in,
      description:
        "Active people with no recorded sign-in. Sign-ins before this feature was added are not counted.",
      href: "/access?view=people&history=no-recorded-sign-in",
    },
    {
      id: "activity",
      title: "Known inactive people",
      count: summary.data?.inactive_people,
      description: `Active people with recorded activity older than ${summary.data?.inactive_days ?? inactiveDays} days. People with no recorded activity are excluded.`,
      href: `/access?view=people&history=inactive&inactive_days=${summary.data?.inactive_days ?? inactiveDays}`,
    },
  ];

  function applyInactiveDays(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const error = inactiveDaysError(inactiveDraft);
    setInactiveError(error);
    if (error) return;
    const days = parseInactiveDays(inactiveDraft);
    if (days !== null) {
      setInactiveDays(days);
      setInactiveDraft(String(days));
    }
  }

  if (denied)
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Only administrators can see the overview</EmptyTitle>
          <EmptyDescription>
            Ask an administrator if you need to check who has access.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-labelledby="access-health" className="space-y-3">
        <h2
          id="access-health"
          data-slot="section-title"
          className="text-base font-semibold"
        >
          What needs attention
        </h2>
        {failed ? (
          <div
            role="alert"
            className="max-w-lg space-y-4 rounded-lg border p-6"
          >
            <div>
              <h3 className="text-base font-semibold">
                The overview could not be loaded
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Check your connection and try again.
              </p>
            </div>
            <Button
              className="min-h-11"
              onClick={() => {
                if (users.isError) void users.refetch();
                if (groups.isError) void groups.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : (
          <LoadingRegion
            loading={health === null}
            label="Loading the overview…"
            skeleton={<HealthSkeleton />}
          >
            {health ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <li className="flex min-w-0">
                  <Card
                    aria-labelledby={`${settingsTitleId}-mfa`}
                    className="flex w-full min-w-0 flex-col gap-2 self-stretch p-4"
                  >
                    <h3
                      id={`${settingsTitleId}-mfa`}
                      data-slot="card-title"
                      className="flex items-center gap-2 text-sm font-semibold"
                    >
                      <ShieldCheck
                        aria-hidden="true"
                        className="text-muted-foreground size-4 shrink-0"
                      />
                      Administrator two-step verification
                    </h3>
                    {summary.isError ? (
                      <Alert variant="destructive" className="space-y-3">
                        <p>Two-step verification status could not load.</p>
                        <Button
                          variant="outline"
                          className="min-h-11"
                          onClick={() => void summary.refetch()}
                        >
                          Try again
                        </Button>
                      </Alert>
                    ) : (
                      <LoadingRegion
                        loading={summary.isPending}
                        label="Loading two-step verification status…"
                        skeleton={<Skeleton className="h-24 w-full" />}
                      >
                        {summary.data ? (
                          <div className="flex flex-col gap-3">
                            <p className="text-lg font-semibold tabular-nums">
                              {summary.data.admins_without_mfa} without two-step
                              verification
                            </p>
                            <p className="text-muted-foreground text-sm tabular-nums">
                              {summary.data.admins_mfa_unknown} unknown
                            </p>
                            {summary.data.admins_without_mfa > 0 ? (
                              <Button
                                asChild
                                variant="outline"
                                className="min-h-11 w-full justify-between"
                              >
                                <GuardedWorkspaceLink href="/access?view=people&role=admin&mfa=without">
                                  Show administrators without two-step
                                  verification
                                  <ArrowRight aria-hidden="true" />
                                </GuardedWorkspaceLink>
                              </Button>
                            ) : null}
                            {summary.data.admins_mfa_unknown > 0 ? (
                              <Button
                                asChild
                                variant="outline"
                                className="min-h-11 w-full justify-between"
                              >
                                <GuardedWorkspaceLink href="/access?view=people&role=admin&mfa=unknown">
                                  Show administrators with unknown status
                                  <ArrowRight aria-hidden="true" />
                                </GuardedWorkspaceLink>
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </LoadingRegion>
                    )}
                  </Card>
                </li>
                {historyCards.map((card) => (
                  <li key={card.id} className="flex min-w-0">
                    <Card
                      aria-labelledby={`${settingsTitleId}-${card.id}`}
                      className="flex w-full min-w-0 flex-col gap-3 self-stretch p-4"
                    >
                      <h3
                        id={`${settingsTitleId}-${card.id}`}
                        data-slot="card-title"
                        className="flex items-center gap-2 text-sm font-semibold"
                      >
                        <Clock3
                          aria-hidden="true"
                          className="text-muted-foreground size-4 shrink-0"
                        />
                        {card.title}
                      </h3>
                      {summary.isError ? (
                        <Alert variant="destructive" className="space-y-3">
                          <p className="text-sm">
                            Recorded history could not be loaded.
                          </p>
                          <Button
                            variant="outline"
                            className="min-h-11"
                            onClick={() => void summary.refetch()}
                          >
                            Retry recorded history
                          </Button>
                        </Alert>
                      ) : (
                        <LoadingRegion
                          loading={summary.isPending}
                          label="Loading recorded history…"
                          skeleton={<Skeleton className="h-24 w-full" />}
                        >
                          {card.count !== undefined && summary.data ? (
                            <div className="space-y-3">
                              <p className="text-3xl font-semibold tabular-nums">
                                {card.count}
                              </p>
                              <p className="text-muted-foreground text-sm">
                                {card.description}
                              </p>
                              <p className="text-muted-foreground text-xs">
                                As of{" "}
                                <time dateTime={summary.data.as_of}>
                                  {formatDateTime(summary.data.as_of)}
                                </time>
                              </p>
                              {card.count > 0 ? (
                                <Button
                                  asChild
                                  variant="outline"
                                  className="min-h-11 w-full justify-between"
                                >
                                  <GuardedWorkspaceLink
                                    href={card.href as Route}
                                  >
                                    Show these people
                                    <ArrowRight aria-hidden="true" />
                                  </GuardedWorkspaceLink>
                                </Button>
                              ) : (
                                <p className="text-muted-foreground flex min-h-11 items-center text-sm">
                                  Nothing to review
                                </p>
                              )}
                            </div>
                          ) : null}
                        </LoadingRegion>
                      )}
                      {card.id === "activity" ? (
                        <form
                          onSubmit={applyInactiveDays}
                          className="mt-auto space-y-3 border-t pt-3"
                          noValidate
                        >
                          <TextField
                            id={`${settingsTitleId}-inactive-days`}
                            label="Inactive for (days)"
                            inputMode="numeric"
                            value={inactiveDraft}
                            onChange={(value) => {
                              setInactiveDraft(value);
                              setInactiveError(null);
                            }}
                            description={`Whole days from ${INACTIVE_DAYS_MIN} to ${INACTIVE_DAYS_MAX}.`}
                            error={inactiveError}
                          />
                          <Button
                            type="submit"
                            variant="outline"
                            className="min-h-11 w-full"
                          >
                            Apply inactivity period
                          </Button>
                        </form>
                      ) : null}
                    </Card>
                  </li>
                ))}
                {healthCards(health).map((card) => (
                  <li key={card.id} className="flex min-w-0">
                    <Card
                      aria-labelledby={`${settingsTitleId}-${card.id}`}
                      className="flex w-full min-w-0 flex-col gap-2 self-stretch p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <h3
                          id={`${settingsTitleId}-${card.id}`}
                          data-slot="card-title"
                          className="flex min-w-0 items-center gap-2 text-sm font-semibold"
                        >
                          <span className="text-muted-foreground shrink-0">
                            {card.icon}
                          </span>
                          {card.title}
                        </h3>
                        {card.attention ? (
                          <Badge variant="warning">Review</Badge>
                        ) : null}
                      </div>
                      <p className="text-3xl font-semibold tabular-nums">
                        {card.count}
                      </p>
                      <p className="text-muted-foreground flex-1 text-sm">
                        {card.description}
                      </p>
                      {card.count > 0 ? (
                        <Button
                          asChild
                          variant="outline"
                          className="min-h-11 w-full justify-between sm:w-fit"
                        >
                          <GuardedWorkspaceLink href={card.href as Route}>
                            {card.linkLabel}
                            <ArrowRight aria-hidden="true" />
                          </GuardedWorkspaceLink>
                        </Button>
                      ) : (
                        <p className="text-muted-foreground flex min-h-11 items-center text-sm">
                          Nothing to review
                        </p>
                      )}
                    </Card>
                  </li>
                ))}
              </ul>
            ) : null}
          </LoadingRegion>
        )}
      </section>

      <Card aria-labelledby={settingsTitleId} className="w-full p-5">
        <div className="mb-4 space-y-1">
          <h2
            id={settingsTitleId}
            data-slot="card-title"
            className="text-base font-semibold"
          >
            Invitation settings
          </h2>
          <p className="text-muted-foreground text-sm">
            These apply to the invitations you send from now on.
          </p>
        </div>
        <InvitationSettings titleId={settingsTitleId} />
      </Card>
    </div>
  );
}
