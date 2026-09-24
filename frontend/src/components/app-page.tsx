"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  clearAccessDraftsForAccountChange,
  clearVerifiedWorkspaceSessionSnapshot,
  keepAccessDraftsForVerifiedWorkspaceUser,
  VerifiedWorkspaceIdentityProvider,
} from "@/components/systems/shared/runtime/workspace-identity";
import { getSessionStatus } from "@/lib/auth-api";

type AppPageProps = {
  children: ReactNode;
};

type SessionCheck = "valid" | "setup" | "invalid" | "unavailable";

type CheckQueue = {
  active: boolean;
  queued: { pathname: string; version: number } | null;
  nextVersion: number;
  requestId: number;
  controller: AbortController | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function classifySessionResponse(
  response: Pick<Response, "ok" | "status">,
  body: unknown,
): SessionCheck {
  if (response.status !== 200 || !response.ok || !isRecord(body))
    return "unavailable";
  if (
    body.authenticated === true &&
    typeof body.user_id === "string" &&
    body.user_id.length > 0 &&
    typeof body.setup_required === "boolean"
  )
    return body.setup_required ? "setup" : "valid";
  if (body.authenticated === false) return "invalid";
  return "unavailable";
}

function sessionUserId(body: unknown): string | null {
  return isRecord(body) &&
    body.authenticated === true &&
    typeof body.user_id === "string" &&
    body.user_id.length > 0 &&
    body.setup_required === false
    ? body.user_id
    : null;
}

export function AppPage({ children }: AppPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [draftCleanupFailed, setDraftCleanupFailed] = useState(false);
  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null);
  const verifiedUserIdRef = useRef<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const mounted = useRef(false);
  const initialCheck = useRef(true);
  const queue = useRef<CheckQueue>({
    active: false,
    queued: null,
    nextVersion: 0,
    requestId: 0,
    controller: null,
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queue.current.controller?.abort();
      queue.current.controller = null;
      queue.current.queued = null;
      queue.current.active = false;
    };
  }, []);

  useEffect(() => {
    const current = queue.current;
    current.queued = {
      pathname,
      version: ++current.nextVersion,
    };
    if (current.active) return;

    current.active = true;
    void (async () => {
      while (current.queued !== null) {
        const requested = current.queued;
        current.queued = null;
        const requestId = ++current.requestId;
        const controller = new AbortController();
        current.controller = controller;
        let result: SessionCheck = "unavailable";
        let responseUserId: string | null = null;
        try {
          const body = await getSessionStatus(controller.signal);
          if (
            !mounted.current ||
            current.requestId !== requestId ||
            current.controller !== controller
          )
            return;
          result = classifySessionResponse({ ok: true, status: 200 }, body);
          responseUserId = sessionUserId(body);
        } catch {
          if (
            !mounted.current ||
            current.requestId !== requestId ||
            current.controller !== controller
          )
            return;
          result = "unavailable";
        } finally {
          if (current.controller === controller) current.controller = null;
        }

        if (!mounted.current || current.requestId !== requestId) return;
        // Do not let a response for an older pathname or retry affect the UI;
        // the loop will immediately process the newest queued request.
        if (current.nextVersion > requested.version) continue;
        if (result === "invalid") {
          if (!clearAccessDraftsForAccountChange()) {
            current.queued = null;
            setVerifiedUserId(null);
            setChecking(true);
            setDraftCleanupFailed(true);
            break;
          }
          current.queued = null;
          void clearVerifiedWorkspaceSessionSnapshot(verifiedUserIdRef.current);
          verifiedUserIdRef.current = null;
          setVerifiedUserId(null);
          setChecking(true);
          router.replace("/login");
          return;
        }
        if (result === "setup") {
          if (!clearAccessDraftsForAccountChange()) {
            current.queued = null;
            setVerifiedUserId(null);
            setChecking(true);
            setDraftCleanupFailed(true);
            break;
          }
          current.queued = null;
          void clearVerifiedWorkspaceSessionSnapshot(verifiedUserIdRef.current);
          verifiedUserIdRef.current = null;
          setVerifiedUserId(null);
          setChecking(true);
          router.replace("/auth/setup?temporary=1");
          return;
        }
        if (result === "valid") {
          if (responseUserId === null) {
            setUnavailable(true);
            continue;
          }
          const previousUserId = verifiedUserIdRef.current;
          const draftsCleared =
            previousUserId !== null && previousUserId !== responseUserId
              ? clearAccessDraftsForAccountChange()
              : keepAccessDraftsForVerifiedWorkspaceUser(responseUserId);
          if (!draftsCleared) {
            current.queued = null;
            setVerifiedUserId(null);
            setChecking(true);
            setDraftCleanupFailed(true);
            break;
          }
          if (previousUserId !== null && previousUserId !== responseUserId)
            void clearVerifiedWorkspaceSessionSnapshot(previousUserId);
          verifiedUserIdRef.current = responseUserId;
          setVerifiedUserId(responseUserId);
          setDraftCleanupFailed(false);
          setUnavailable(false);
          if (initialCheck.current) {
            initialCheck.current = false;
          }
          setChecking(false);
        } else {
          setUnavailable(true);
        }
      }
      current.active = false;
    })();
  }, [pathname, retryVersion, router]);

  function retrySessionCheck() {
    if (initialCheck.current) setUnavailable(false);
    setDraftCleanupFailed(false);
    setRetryVersion((version) => version + 1);
  }

  if (checking) {
    return (
      <main className="bg-background text-foreground grid min-h-screen place-items-center">
        <div className="max-w-sm px-6 text-center">
          {draftCleanupFailed ? (
            <>
              <p className="text-foreground text-sm" role="alert">
                We could not clear saved Access drafts in this tab. Close this
                tab before another person signs in, or clear this site&apos;s
                session data and retry.
              </p>
              <button
                className="bg-primary text-primary-foreground mt-5 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium"
                onClick={retrySessionCheck}
                type="button"
              >
                Retry
              </button>
            </>
          ) : unavailable ? (
            <>
              <p className="text-foreground text-sm" role="alert">
                We can’t verify your session right now. Your sign-in details are
                still available.
              </p>
              <button
                className="bg-primary text-primary-foreground mt-5 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium"
                onClick={retrySessionCheck}
                type="button"
              >
                Retry
              </button>
            </>
          ) : (
            <p className="text-muted-foreground text-sm" role="status">
              Checking your session…
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <VerifiedWorkspaceIdentityProvider userId={verifiedUserId}>
      <AppShell verifiedUserId={verifiedUserId}>{children}</AppShell>
      {unavailable && (
        <div
          className="bg-destructive text-destructive-foreground fixed right-4 bottom-4 z-[80] flex max-w-sm items-center gap-3 rounded-md px-4 py-3 text-sm shadow-lg"
          role="alert"
        >
          <span>Session verification is temporarily unavailable.</span>
          <button
            className="min-h-11 shrink-0 rounded-md border border-current px-3 font-medium"
            onClick={retrySessionCheck}
            type="button"
          >
            Retry
          </button>
        </div>
      )}
    </VerifiedWorkspaceIdentityProvider>
  );
}
