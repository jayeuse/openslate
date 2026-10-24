"use client";

import { Suspense, useEffect, type ReactNode } from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { UserCog } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { avatarThumbnailUrl, personInitials } from "@/components/person-avatar";
import {
  GuardedWorkspaceLink,
  useWorkspaceNavigationRequest,
} from "@/components/workspace-navigation-guard";
import type { PersonProfile } from "./adapters/profile-api";
import { profileFacts } from "./domain/profile-rows";
import { useAdmittedWorkspaceScope } from "@/components/systems/shared/runtime/workspace-identity";
import { cn } from "@/lib/utils";
import { useProfileView } from "./hooks/use-profile-view";

/** The editing anchors of the old Profile page; they now open Account settings. */
const SETTINGS_ANCHORS = new Set([
  "#identity",
  "#security",
  "#look",
  "#regional",
]);

/**
 * The read-only Profile view (PD16, PD18): a quiet band, the photo, name and
 * job title on the left, and About and Bio as label-left panels on the right.
 * From 1280px the page is still; below it, one column that scrolls.
 */
export default function Profile() {
  return (
    <Suspense fallback={<ProfileFrame />}>
      <ProfileContent />
    </Suspense>
  );
}

function ProfileContent() {
  const view = useProfileView();
  useSettingsAnchorRedirect();
  useProfileTitle(
    view.status !== "unavailable" && view.own
      ? "Your profile"
      : view.status === "ready"
        ? view.profile.displayName
        : "Profile",
  );
  if (view.status === "unavailable")
    return (
      <Alert className="flex flex-wrap items-center gap-3">
        <p className="mr-auto">This profile is not available.</p>
        <GuardedWorkspaceLink
          href={"/profile" as Route}
          className="text-action-text inline-flex min-h-11 items-center font-medium underline underline-offset-4 xl:min-h-8"
        >
          Go to your profile
        </GuardedWorkspaceLink>
      </Alert>
    );
  if (view.status === "failed")
    return (
      <Alert
        variant="destructive"
        className="flex flex-wrap items-center gap-3"
      >
        <p className="mr-auto">This profile could not load.</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 xl:min-h-8"
          disabled={view.retrying}
          onClick={view.retry}
        >
          Retry
        </Button>
      </Alert>
    );
  return (
    <ProfileFrame>
      <LoadingRegion
        loading={view.status === "loading"}
        label="Loading profile…"
        skeleton={<ProfileSkeleton />}
        // Pass the frame's height to the facts column, which scrolls alone.
        className="flex min-h-0 flex-1 flex-col *:flex *:min-h-0 *:flex-1 *:flex-col"
      >
        {view.status === "ready" ? (
          <ProfileDetails profile={view.profile} own={view.own} />
        ) : null}
      </LoadingRegion>
    </ProfileFrame>
  );
}

/**
 * The tab names the profile it shows. The static page title is "Profile"; an
 * OpenComms unread prefix ("(3) ") stays in front, and route metadata that
 * replaces the title on this page is corrected again.
 */
function useProfileTitle(name: string) {
  useEffect(() => {
    const title = `${name} | OpenSlate`;
    const apply = () => {
      if (window.location.pathname !== "/profile") return;
      const prefix = /^\(\d+\+?\) /.exec(document.title)?.[0] ?? "";
      if (document.title !== prefix + title) document.title = prefix + title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [name]);
}

/** /profile#look and the other old editing anchors open the same group in Account settings. */
function useSettingsAnchorRedirect() {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const person = useSearchParams().get("person");
  useEffect(() => {
    if (person) return;
    const open = () => {
      const hash = window.location.hash;
      if (!SETTINGS_ANCHORS.has(hash)) return;
      const target = `/settings${hash}`;
      const replace = () => router.replace(target as Route);
      if (requestNavigation(target, replace)) replace();
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, [person, router, requestNavigation]);
}

/**
 * In the shell the band spans the content area: the frame cancels the page
 * padding of #main-content (PD27), and from 1280px it fills the viewport
 * below the header so only the facts column scrolls. The no-organization
 * frame has no shell, so there the band is a rounded block in its column.
 */
function ProfileFrame({ children }: { children?: ReactNode }) {
  const inShell = useAdmittedWorkspaceScope() !== null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        inShell &&
          "-m-4 sm:-mx-5 sm:-my-7 xl:h-[calc(100dvh-3.5rem)] xl:overflow-hidden",
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "border-border h-24 shrink-0 bg-(--surface-sunken) md:h-30",
          inShell ? "border-b" : "rounded-[var(--radius)] border",
        )}
      />
      {children}
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 sm:px-5 xl:px-7">
      <Skeleton className="-mt-12 size-24 rounded-full" />
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-36" />
    </div>
  );
}

function ProfileDetails({
  profile,
  own,
}: {
  profile: PersonProfile;
  own: boolean;
}) {
  const { about, bio, fillHint } = profileFacts(profile, own);
  const photo = avatarThumbnailUrl(profile.avatarUrl, 256);
  return (
    <div className="slim-ui flex min-h-0 flex-1 flex-col gap-5 px-4 pb-6 text-sm sm:px-5 xl:grid xl:grid-cols-[18.75rem_minmax(0,1fr)] xl:gap-8 xl:px-7">
      <section
        aria-labelledby="profile-name"
        className="-mt-12 flex min-w-0 flex-col items-start"
      >
        <Avatar aria-hidden="true" className="ring-background size-24 ring-4">
          {photo ? <AvatarImage src={photo} alt="" /> : null}
          <AvatarFallback className="bg-card text-muted-foreground text-3xl font-semibold">
            {personInitials(profile.displayName)}
          </AvatarFallback>
        </Avatar>
        <h1
          id="profile-name"
          data-slot="page-title"
          className="mt-3.5 text-2xl leading-8 font-semibold tracking-[-0.02em] wrap-anywhere"
        >
          {profile.displayName}
        </h1>
        {profile.jobTitle?.trim() ? (
          <p className="text-muted-foreground mt-0.5 wrap-anywhere">
            {profile.jobTitle}
          </p>
        ) : null}
        {own ? (
          <Button asChild variant="secondary" className="mt-4 min-h-11">
            <GuardedWorkspaceLink href={"/settings" as Route}>
              <UserCog aria-hidden="true" />
              Account settings
            </GuardedWorkspaceLink>
          </Button>
        ) : null}
      </section>
      {about.length || bio || fillHint ? (
        <div className="flex min-h-0 max-w-[47.5rem] flex-col gap-4 xl:overflow-y-auto xl:pt-6">
          {about.length ? (
            <ProfilePanel id="profile-about" title="About">
              <dl>
                {about.map((row) => (
                  <div
                    key={row.label}
                    className="border-border grid min-h-14 grid-cols-1 content-center gap-y-0.5 border-b px-4 py-2 last:border-b-0 md:min-h-10 md:grid-cols-[8rem_minmax(0,1fr)] md:items-center md:gap-x-4 md:py-1"
                  >
                    <dt className="text-muted-foreground text-[0.8125rem]">
                      {row.label}
                    </dt>
                    <dd className="min-w-0 wrap-anywhere">
                      {"groups" in row ? (
                        <ul className="flex flex-wrap gap-1.5 py-1">
                          {row.groups.map((group) => (
                            <li key={group.id}>
                              <Badge variant="secondary">{group.name}</Badge>
                            </li>
                          ))}
                        </ul>
                      ) : "href" in row ? (
                        // A phone can call the number (PD59); a 44px target
                        // below 1280px, as the hint link is (PD50).
                        <a
                          href={row.href}
                          className="text-action-text focus-visible:outline-ring inline-flex min-h-11 items-center rounded-sm tabular-nums underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 xl:inline xl:min-h-0"
                        >
                          {row.value}
                        </a>
                      ) : (
                        row.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </ProfilePanel>
          ) : null}
          {fillHint ? (
            <p className="text-muted-foreground text-sm">
              Add your job title, phone, and bio in{" "}
              <GuardedWorkspaceLink
                href={"/settings#identity" as Route}
                // A 44px target below 1280px; it ends the line (PD50).
                className="text-action-text focus-visible:outline-ring inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 xl:inline xl:min-h-0"
              >
                Account settings
              </GuardedWorkspaceLink>
              .
            </p>
          ) : null}
          {bio ? (
            <ProfilePanel id="profile-bio" title="Bio">
              <p className="max-w-[65ch] px-4 pt-3 pb-3.5 wrap-anywhere whitespace-pre-wrap">
                {bio}
              </p>
            </ProfilePanel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProfilePanel({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="bg-card border-border shrink-0 rounded-[var(--radius)] border"
    >
      <div className="border-border flex min-h-10 items-center border-b px-4 py-2">
        <h2
          id={id}
          data-slot="section-title"
          className="text-base font-semibold"
        >
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}
