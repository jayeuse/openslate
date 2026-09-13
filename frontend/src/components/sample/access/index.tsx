"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  ArrowUpRight,
  BookOpenCheck,
  KeyRound,
  LayoutDashboard,
  Network,
  ShieldCheck,
  UserRoundCog,
  UsersRound,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { useAccessController } from "./controller";
import {
  GovernanceDialogs,
  type GovernanceDialogTarget,
} from "./governance-dialogs";
import { GroupsView } from "./groups-view";
import { IdentitiesView } from "./identities-view";
import { OverviewView, type AccessOverviewDestination } from "./overview-view";
import type { AccessSubjectRef } from "./policy";
import { ReviewsView } from "./reviews-view";
import { RolesView } from "./roles-view";
import { RulesView } from "./rules-view";
import { SimulatorView } from "./simulator-view";

const accessViews = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "identities", label: "Identities", icon: UserRoundCog },
  { id: "roles", label: "Roles", icon: ShieldCheck },
  { id: "groups", label: "Groups", icon: UsersRound },
  { id: "rules", label: "Access rules", icon: KeyRound },
  { id: "simulator", label: "Simulator", icon: Network },
  { id: "reviews", label: "Reviews", icon: BookOpenCheck },
] as const;

const accessPanelClass = "min-h-0 flex-1 overflow-y-auto overscroll-contain";

type AccessView = (typeof accessViews)[number]["id"];

function isAccessView(value: string | null): value is AccessView {
  return accessViews.some((view) => view.id === value);
}

function AccessFallback() {
  return (
    <div
      className="h-full space-y-5 overflow-hidden p-3 sm:px-5 sm:py-4"
      role="status"
      aria-label="Opening Access"
    >
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-full max-w-xl" />
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}

export default function SampleAccess() {
  return (
    <Suspense fallback={<AccessFallback />}>
      <AccessControlCenter />
    </Suspense>
  );
}

function AccessControlCenter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const controller = useAccessController();
  const [requestedSubject, setRequestedSubject] = useState<AccessSubjectRef>();
  const [governanceDialog, setGovernanceDialog] =
    useState<GovernanceDialogTarget | null>(null);

  const requestedView = searchParams.get("view");
  const requestedUser = searchParams.get("user");
  const hasUserDeepLink =
    requestedUser !== null &&
    [
      ...controller.state.identities,
      ...controller.state.deletedIdentities.map((item) => item.identity),
    ].some((identity) => identity.id === requestedUser);
  const activeView: AccessView = isAccessView(requestedView)
    ? requestedView
    : hasUserDeepLink
      ? "identities"
      : "overview";

  useEffect(() => {
    if (requestedUser === null || hasUserDeepLink) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("user");
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}` as Route);
  }, [hasUserDeepLink, pathname, requestedUser, router, searchParams]);

  function navigate(view: AccessView, options?: { keepSubject?: boolean }) {
    if (!options?.keepSubject) setRequestedSubject(undefined);
    const next = new URLSearchParams();
    next.set("view", view);
    if (view === "identities") {
      const user = searchParams.get("user");
      if (user) next.set("user", user);
    }
    router.push(`${pathname}?${next.toString()}` as Route);
  }

  function navigateFromOverview(destination: AccessOverviewDestination) {
    if (
      destination === "defaults" ||
      destination === "import" ||
      destination === "export"
    ) {
      setGovernanceDialog(destination);
      return;
    }
    navigate(destination);
  }

  function openRulesForGroup(groupId: string) {
    setRequestedSubject({ kind: "group", id: groupId });
    navigate("rules", { keepSubject: true });
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 p-3 sm:px-5 sm:py-4">
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Access
          </h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Manage identities, roles, groups, and access policies.
          </p>
        </div>
        <Button asChild variant="outline" className="min-h-11 shrink-0 px-3">
          <Link href="/manage?view=security">
            <ShieldCheck aria-hidden="true" />
            Manage security
            <ArrowUpRight aria-hidden="true" />
          </Link>
        </Button>
      </header>

      <Tabs
        value={activeView}
        onValueChange={(value) => {
          const requested = String(value);
          if (isAccessView(requested)) navigate(requested);
        }}
        className="min-h-0 flex-1 gap-3"
      >
        <div className="shrink-0 lg:hidden">
          <label
            htmlFor="access-view"
            className="text-foreground mb-2 block text-sm font-medium"
          >
            Access view
          </label>
          <NativeSelect
            id="access-view"
            className="w-full [&>select]:min-h-11"
            value={activeView}
            onChange={(event) => {
              const value = event.target.value;
              if (isAccessView(value)) navigate(value);
            }}
          >
            {accessViews.map((view) => (
              <NativeSelectOption key={view.id} value={view.id}>
                {view.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        <div className="hidden min-w-0 shrink-0 overflow-x-auto lg:block">
          <TabsList
            aria-label="Access views"
            className="min-w-max bg-transparent p-0"
          >
            {accessViews.map(({ id, label, icon: Icon }) => (
              <TabsTrigger
                key={id}
                value={id}
                className="data-active:bg-muted min-h-11 gap-2 px-3 data-active:shadow-none"
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className={accessPanelClass}>
          <OverviewView
            controller={controller}
            onNavigate={navigateFromOverview}
          />
        </TabsContent>
        <TabsContent value="identities" className={accessPanelClass}>
          <IdentitiesView controller={controller} />
        </TabsContent>
        <TabsContent value="roles" className={accessPanelClass}>
          <RolesView controller={controller} />
        </TabsContent>
        <TabsContent value="groups" className={accessPanelClass}>
          <GroupsView
            controller={controller}
            onOpenRulesForGroup={openRulesForGroup}
          />
        </TabsContent>
        <TabsContent value="rules" className={accessPanelClass}>
          <RulesView
            key={
              requestedSubject?.kind === "group"
                ? `rules-${requestedSubject.id}`
                : "rules"
            }
            controller={controller}
            initialSubject={requestedSubject}
          />
        </TabsContent>
        <TabsContent value="simulator" className={accessPanelClass}>
          <SimulatorView controller={controller} />
        </TabsContent>
        <TabsContent
          value="reviews"
          className={`${accessPanelClass} grid gap-4 xl:grid-cols-2 xl:items-start`}
        >
          <ReviewsView controller={controller} />
          <GovernanceDialogs
            controller={controller}
            dialog={governanceDialog}
            onDialogChange={setGovernanceDialog}
          />
        </TabsContent>
      </Tabs>

      {activeView !== "reviews" && (
        <GovernanceDialogs
          controller={controller}
          dialog={governanceDialog}
          onDialogChange={setGovernanceDialog}
          showLauncher={false}
        />
      )}
    </div>
  );
}
