"use client";

import { useEffect, useId, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleHelp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "@/components/ui/sheet";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { currentNavigationKey } from "@/components/workspace-navigation";
import { useUserPreferences } from "@/components/theme-provider";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { subscribeWorkspaceInvalidations } from "@/components/systems/shared/adapters/invalidation-events";
import { helpWorkspaceContactsOptions } from "@/components/systems/manage/adapters/manage-queries";
import {
  SANDBOX_SHORTCUTS,
  SANDBOX_SHORTCUT_SCOPE,
  sandboxShortcutKeys,
} from "@/lib/shortcuts";
import { pageGuideForNavigation } from "./page-guides";

function AdministratorContacts({ userId }: { userId: string }) {
  const client = useQueryClient();
  const query = useQuery(helpWorkspaceContactsOptions(userId));
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({
        queryKey: helpWorkspaceContactsOptions(userId).queryKey,
      });
    };
    return subscribeWorkspaceInvalidations((event) => {
      if (
        event.type === "resync" ||
        event.entity === "workspace_profiles" ||
        event.entity === "users"
      )
        refresh();
    }, refresh);
  }, [client, userId]);

  // A current read/refusal takes precedence over previously accepted metadata.
  const contacts = query.isFetching || query.isError ? undefined : query.data;
  if (query.isError && !query.isFetching)
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          Administrator contacts could not be loaded. Retry to check the current
          details.
        </Alert>
        <Button
          className="min-h-11"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  if (contacts?.kind === "guest")
    return (
      <p className="text-muted-foreground text-sm">
        Contact the person who invited you.
      </p>
    );
  const email = contacts?.kind === "full" ? contacts.email?.trim() : null;
  const phone = contacts?.kind === "full" ? contacts.phone?.trim() : null;
  return (
    <LoadingRegion
      loading={!contacts}
      label="Loading administrator contacts…"
      skeleton={
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      }
    >
      {contacts && !email && !phone ? (
        <p className="text-muted-foreground text-sm">
          Administrator contacts have not been configured.
        </p>
      ) : contacts ? (
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="mt-1 break-words">{email || "Not provided"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Phone</dt>
            <dd className="mt-1 break-words">{phone || "Not provided"}</dd>
          </div>
        </dl>
      ) : null}
    </LoadingRegion>
  );
}

export function HelpPanel() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const { keyboardShortcuts, disabled, loading, saving } = useUserPreferences();
  const [open, setOpen] = useState(false);
  const id = useId();
  const guide = pageGuideForNavigation(
    currentNavigationKey(
      pathname,
      new URLSearchParams(searchParams.toString()),
    ),
  );
  const enabled = keyboardShortcuts === true && !disabled;
  const preferencePending = loading || saving;
  return (
    <Sheet open={open && !suspended} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 xl:size-8"
            aria-label="Help"
            title="Help"
            disabled={suspended}
          />
        }
      >
        <CircleHelp className="size-5" aria-hidden="true" />
      </SheetTrigger>
      <SheetContent className="w-[min(92vw,28rem)] gap-0 p-0">
        <div className="flex items-start justify-between gap-3 border-b p-5">
          <div className="space-y-1">
            <SheetTitle>Help</SheetTitle>
            <SheetDescription>
              Quick guidance without leaving your work.
            </SheetDescription>
          </div>
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label="Close Help"
              />
            }
          >
            <X className="size-5" aria-hidden="true" />
          </SheetClose>
        </div>
        <div className="space-y-7 p-5">
          <section aria-labelledby={`${id}-page`} className="space-y-3">
            <h2
              id={`${id}-page`}
              data-slot="section-title"
              className="text-base font-semibold"
            >
              This page
            </h2>
            {guide ? (
              <>
                <h3 className="text-sm font-medium">{guide.title}</h3>
                <ul className="text-muted-foreground list-disc space-y-3 pl-5 text-sm leading-6">
                  {guide.entries.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                Choose a workspace page to see its guide.
              </p>
            )}
          </section>
          <section
            aria-labelledby={`${id}-shortcuts`}
            className="space-y-3 border-t pt-5"
          >
            <h2
              id={`${id}-shortcuts`}
              data-slot="section-title"
              className="text-base font-semibold"
            >
              Keyboard shortcuts
            </h2>
            {preferencePending ? (
              <p className="text-muted-foreground text-sm" role="status">
                Loading your confirmed shortcut preference…
              </p>
            ) : keyboardShortcuts === false ? (
              <p className="text-muted-foreground text-sm">
                Shortcuts are off. Turn them on in your profile.
              </p>
            ) : disabled ? (
              <p className="text-muted-foreground text-sm">
                Shortcut preferences are unavailable. Check your profile to
                retry.
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">
              {SANDBOX_SHORTCUT_SCOPE} only. Text editing and open dialogs keep
              their own controls.
            </p>
            <dl className="space-y-3 text-sm">
              {Object.values(SANDBOX_SHORTCUTS)
                .filter((shortcut) => enabled || shortcut.browserStandard)
                .map((shortcut) => (
                  <div key={shortcut.label} className="space-y-1">
                    <dt className="font-medium">{shortcut.label}</dt>
                    <dd className="text-muted-foreground flex flex-wrap gap-1.5">
                      {sandboxShortcutKeys(shortcut).map((keys) => (
                        <kbd
                          key={keys}
                          className="bg-muted rounded border px-1.5 py-0.5 text-xs"
                        >
                          {keys}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
            </dl>
            <p className="text-muted-foreground text-xs">
              Standard undo and redo remain available when shortcuts are off.
              Arrow editing and Enter or Space activation always work.
            </p>
            <GuardedWorkspaceLink
              href="/profile#look"
              onAcceptedNavigate={() => setOpen(false)}
              className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center rounded-md text-sm underline underline-offset-4 focus-visible:outline-2"
            >
              Open your profile
            </GuardedWorkspaceLink>
          </section>
          <section
            aria-labelledby={`${id}-contacts`}
            className="space-y-3 border-t pt-5"
          >
            <h2
              id={`${id}-contacts`}
              data-slot="section-title"
              className="text-base font-semibold"
            >
              Contact your administrator
            </h2>
            {open && !suspended ? (
              <AdministratorContacts userId={userId} />
            ) : null}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
