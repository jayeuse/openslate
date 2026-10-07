"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AppQueryProvider } from "@/components/query-provider";
import {
  clearAccessDraftsForAccountChange,
  clearVerifiedWorkspaceSessionSnapshot,
  keepAccessDraftsForVerifiedWorkspaceUser,
  VerifiedWorkspaceIdentityProvider,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  getSessionStatus,
  requestSessionRecheck,
  sessionRecheckEvent,
  signOut,
} from "@/lib/auth-api";
import { ApiError, refreshBrowserSession } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getMfaStatus, type MfaStatus } from "@/lib/mfa-api";
import {
  MfaFlowContext,
  MfaPresentation,
  MfaCleanupNotice,
  useMfaController,
} from "@/components/mfa-flow";

type AppPageProps = {
  children: ReactNode;
};

type SessionCheck =
  "valid" | "setup" | "invalid" | "unavailable" | "mfa" | "network";

// The shortest persisted workspace idle policy is fifteen minutes. Renewal
// is initiated by trusted input, never by a timer or background request.
const activityRenewalInterval = 5 * 60_000;

type CheckQueue = {
  active: boolean;
  queued: { pathname: string; version: number } | null;
  nextVersion: number;
  requestId: number;
  controller: AbortController | null;
};

function supersedeSessionCheck(current: CheckQueue) {
  current.nextVersion += 1;
  current.requestId += 1;
  const controller = current.controller;
  current.controller = null;
  current.queued = null;
  current.active = false;
  controller?.abort();
}

function SessionVerificationMessage({
  draftCleanupFailed,
  unavailable,
  onRetry,
  onSignOut,
  signOutError,
}: {
  draftCleanupFailed: boolean;
  unavailable: boolean;
  onRetry: () => void;
  onSignOut?: () => void;
  signOutError?: boolean;
}) {
  return (
    <div className="mx-auto max-w-sm px-6">
      {draftCleanupFailed ? (
        <Alert variant="destructive">
          We could not clear saved Access drafts in this tab. Close this tab
          before another person signs in, or clear this site&apos;s session data
          and retry.
        </Alert>
      ) : unavailable ? (
        <Alert variant="destructive">
          We can’t verify your session right now. Your sign-in details are still
          available.
        </Alert>
      ) : (
        <p className="text-muted-foreground text-center text-sm" role="status">
          Checking your session…
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-center gap-3">
        <Button className="min-h-11" onClick={onRetry} type="button">
          {unavailable ? "Retry" : "Check again"}
        </Button>
        {onSignOut && (
          <Button
            className="min-h-11"
            variant="outline"
            onClick={onSignOut}
            type="button"
          >
            Sign out
          </Button>
        )}
      </div>
      {signOutError && (
        <Alert variant="destructive" className="mt-3">
          Sign-out could not finish. Try again.
        </Alert>
      )}
    </div>
  );
}

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
  const [forceFallback, setForceFallback] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [networkDenied, setNetworkDenied] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [draftCleanupFailed, setDraftCleanupFailed] = useState(false);
  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null);
  const verifiedUserIdRef = useRef<string | null>(null);
  const signOutAccepted = useRef(false);
  const activityAttempt = useRef<{ userId: string; at: number } | null>(null);
  const stopActivityRenewal = useRef<(() => void) | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const mounted = useRef(false);
  const curtain = useRef<HTMLDialogElement | null>(null);
  const protectedWorkspace = useRef<HTMLDivElement | null>(null);
  const queue = useRef<CheckQueue>({
    active: false,
    queued: null,
    nextVersion: 0,
    requestId: 0,
    controller: null,
  });
  const mfa = useMfaController(requestSessionRecheck, finishFactorRemoval);
  const { bind: bindMfa, hide: hideMfa, clear: clearMfa } = mfa;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      supersedeSessionCheck(queue.current);
    };
  }, []);

  useEffect(() => {
    if (checking || unavailable || verifiedUserId === null) return;
    if (activityAttempt.current?.userId !== verifiedUserId)
      activityAttempt.current = { userId: verifiedUserId, at: Date.now() };
    const controller = new AbortController();
    let renewing = false;
    function onActivity(event: Event) {
      if (
        !event.isTrusted ||
        document.visibilityState !== "visible" ||
        controller.signal.aborted ||
        signOutAccepted.current ||
        queue.current.active ||
        verifiedUserIdRef.current !== verifiedUserId ||
        renewing
      )
        return;
      const now = Date.now();
      if (
        !activityAttempt.current ||
        now - activityAttempt.current.at < activityRenewalInterval
      )
        return;
      activityAttempt.current.at = now;
      renewing = true;
      void refreshBrowserSession({
        userId: verifiedUserId!,
        signal: controller.signal,
      }).then((result) => {
        renewing = false;
        if (
          controller.signal.aborted ||
          !mounted.current ||
          signOutAccepted.current ||
          verifiedUserIdRef.current !== verifiedUserId
        )
          return;
        if (result === "rejected" || result === "unavailable")
          requestSessionRecheck();
      });
    }
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const event of events)
      document.addEventListener(event, onActivity, {
        capture: true,
        passive: true,
      });
    function cleanup() {
      controller.abort();
      for (const event of events)
        document.removeEventListener(event, onActivity, true);
      if (stopActivityRenewal.current === cleanup)
        stopActivityRenewal.current = null;
    }
    stopActivityRenewal.current = cleanup;
    return cleanup;
  }, [checking, unavailable, verifiedUserId]);

  useEffect(() => {
    function concealWorkspace() {
      if (!mounted.current || signOutAccepted.current) return;
      // A tab's cookie identity can change elsewhere. Invalidate an in-flight
      // result and cover even body-level portals before the next browser paint.
      supersedeSessionCheck(queue.current);
      hideMfa();
      try {
        if (curtain.current && !curtain.current.open)
          curtain.current.showModal();
        else if (!curtain.current && verifiedUserIdRef.current !== null)
          throw new Error("Session curtain is unavailable");
      } catch {
        // If the browser cannot open the top layer, unmount instead of
        // risking a visible prior identity.
        flushSync(() => setForceFallback(true));
      }
      flushSync(() => {
        setChecking(true);
        setUnavailable(false);
      });
    }

    function recheckOnReturn() {
      if (signOutAccepted.current || document.visibilityState !== "visible")
        return;
      concealWorkspace();
      setRetryVersion((version) => version + 1);
    }

    function concealMountedWorkspace() {
      // The first session request has no protected tree to conceal. Let it
      // finish while backgrounded; a later focus will supersede and recheck.
      if (!curtain.current && !mfaRequired) return;
      concealWorkspace();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") concealMountedWorkspace();
      else recheckOnReturn();
    }

    window.addEventListener("blur", concealMountedWorkspace);
    window.addEventListener("focus", recheckOnReturn);
    window.addEventListener(sessionRecheckEvent, recheckOnReturn);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", concealMountedWorkspace);
      window.removeEventListener("focus", recheckOnReturn);
      window.removeEventListener(sessionRecheckEvent, recheckOnReturn);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hideMfa, mfaRequired]);

  useEffect(() => {
    // Commit a newly verified identity (and its keyed workspace) before the
    // old account's privacy curtain is dismissed.
    if (!checking && curtain.current?.open) curtain.current.close();
  }, [checking, verifiedUserId]);

  useEffect(() => {
    // Modal cleanup may remove attributes it added before revalidation.
    // Reassert the gate after child dialog effects release their modal scope.
    if (checking) {
      protectedWorkspace.current?.setAttribute("aria-hidden", "true");
      curtain.current?.removeAttribute("aria-hidden");
    }
  }, [checking, mfaRequired, mfa.mode]);

  useEffect(() => {
    if (signOutAccepted.current) return;
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
        let mfaStatus: MfaStatus | null = null;
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
        } catch (caught) {
          if (
            !mounted.current ||
            current.requestId !== requestId ||
            current.controller !== controller
          )
            return;
          if (
            caught instanceof ApiError &&
            caught.status === 403 &&
            caught.code === "mfa_required"
          ) {
            try {
              mfaStatus = await getMfaStatus(controller.signal);
              result = "mfa";
            } catch {
              result = "mfa";
            }
          } else
            result =
              caught instanceof ApiError &&
              caught.status === 403 &&
              caught.code === "ip_not_allowed"
                ? "network"
                : "unavailable";
        } finally {
          if (current.controller === controller) current.controller = null;
        }

        if (!mounted.current || current.requestId !== requestId) return;
        // Do not let a response for an older pathname or retry affect the UI;
        // the loop will immediately process the newest queued request.
        if (current.nextVersion > requested.version) continue;
        if (result === "invalid") {
          toast.clearWorkspace();
          clearMfa();
          if (!clearAccessDraftsForAccountChange()) {
            current.queued = null;
            setVerifiedUserId(null);
            setChecking(true);
            setDraftCleanupFailed(true);
            break;
          }
          current.queued = null;
          const cleanup = clearVerifiedWorkspaceSessionSnapshot(
            verifiedUserIdRef.current,
          );
          verifiedUserIdRef.current = null;
          setVerifiedUserId(null);
          setChecking(true);
          const cleared = await cleanup;
          if (!mounted.current || current.requestId !== requestId) return;
          if (current.nextVersion > requested.version) continue;
          if (!cleared) {
            setDraftCleanupFailed(true);
            break;
          }
          router.replace("/login");
          return;
        }
        if (result === "setup") {
          toast.clearWorkspace();
          clearMfa();
          if (!clearAccessDraftsForAccountChange()) {
            current.queued = null;
            setVerifiedUserId(null);
            setChecking(true);
            setDraftCleanupFailed(true);
            break;
          }
          current.queued = null;
          const cleanup = clearVerifiedWorkspaceSessionSnapshot(
            verifiedUserIdRef.current,
          );
          verifiedUserIdRef.current = null;
          setVerifiedUserId(null);
          setChecking(true);
          const cleared = await cleanup;
          if (!mounted.current || current.requestId !== requestId) return;
          if (current.nextVersion > requested.version) continue;
          if (!cleared) {
            setDraftCleanupFailed(true);
            break;
          }
          router.replace("/auth/setup");
          return;
        }
        if (result === "valid") {
          if (responseUserId === null) {
            setUnavailable(true);
            continue;
          }
          const previousUserId = verifiedUserIdRef.current;
          if (previousUserId !== null && previousUserId !== responseUserId)
            toast.clearWorkspace();
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
          if (previousUserId !== null && previousUserId !== responseUserId) {
            const cleanup =
              clearVerifiedWorkspaceSessionSnapshot(previousUserId);
            verifiedUserIdRef.current = null;
            setVerifiedUserId(null);
            setChecking(true);
            const cleared = await cleanup;
            if (!mounted.current || current.requestId !== requestId) return;
            if (current.nextVersion > requested.version) continue;
            if (!cleared) {
              setDraftCleanupFailed(true);
              break;
            }
          }
          verifiedUserIdRef.current = responseUserId;
          bindMfa(responseUserId, "workspace");
          setMfaRequired(false);
          setNetworkDenied(false);
          setVerifiedUserId(responseUserId);
          setDraftCleanupFailed(false);
          setForceFallback(false);
          setUnavailable(false);
          setChecking(false);
        } else if (result === "mfa" && mfaStatus !== null) {
          try {
            if (curtain.current && !curtain.current.open)
              curtain.current.showModal();
          } catch {
            setForceFallback(true);
          }
          bindMfa(mfaStatus.user_id, "gate", mfaStatus);
          setMfaRequired(true);
          setNetworkDenied(false);
          setUnavailable(false);
          setChecking(true);
        } else if (result === "mfa") {
          try {
            if (curtain.current && !curtain.current.open)
              curtain.current.showModal();
          } catch {
            setForceFallback(true);
          }
          hideMfa();
          setMfaRequired(true);
          setNetworkDenied(false);
          setUnavailable(true);
          setChecking(true);
        } else if (result === "network") {
          try {
            if (curtain.current && !curtain.current.open)
              curtain.current.showModal();
          } catch {
            setForceFallback(true);
          }
          hideMfa();
          setMfaRequired(false);
          setNetworkDenied(true);
          setUnavailable(false);
          setChecking(true);
        } else {
          hideMfa();
          setUnavailable(true);
        }
      }
      current.active = false;
    })();
  }, [pathname, retryVersion, router, bindMfa, clearMfa, hideMfa]);

  function retrySessionCheck() {
    hideMfa();
    supersedeSessionCheck(queue.current);
    setUnavailable(false);
    setDraftCleanupFailed(false);
    setRetryVersion((version) => version + 1);
  }

  function finishFactorRemoval() {
    toast.clearWorkspace();
    stopActivityRenewal.current?.();
    supersedeSessionCheck(queue.current);
    clearMfa();
    setMfaRequired(false);
    setNetworkDenied(false);
    if (!clearAccessDraftsForAccountChange()) {
      setVerifiedUserId(null);
      setChecking(true);
      setDraftCleanupFailed(true);
      return;
    }
    signOutAccepted.current = true;
    void clearVerifiedWorkspaceSessionSnapshot(verifiedUserIdRef.current);
    verifiedUserIdRef.current = null;
    setVerifiedUserId(null);
    setChecking(true);
    router.replace("/login");
  }

  async function signOutFromGate() {
    setSignOutError(false);
    try {
      await signOut();
      finishFactorRemoval();
    } catch {
      setSignOutError(true);
    }
  }

  const verification =
    mfaRequired && mfa.mode === "gate" ? (
      <section
        className="w-full max-w-lg px-6 py-8"
        aria-label="Two-step verification"
      >
        <h2 className="text-xl font-semibold">
          Complete two-step verification
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Verify this account before continuing to your workspace.
        </p>
        <MfaPresentation flow={mfa} gate />
        <div className="mt-2 flex flex-wrap gap-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={retrySessionCheck}
          >
            Check again
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void signOutFromGate()}
          >
            Sign out
          </Button>
        </div>
        {signOutError && (
          <Alert variant="destructive" className="mt-3">
            Sign-out could not finish. Try again.
          </Alert>
        )}
      </section>
    ) : networkDenied ? (
      <div className="mx-auto max-w-sm px-6">
        <Alert variant="destructive">
          Access from this address is not allowed. Use an allowed network, or
          contact your administrator.
        </Alert>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={retrySessionCheck}
          >
            Retry
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => void signOutFromGate()}
          >
            Sign out
          </Button>
        </div>
        {signOutError && (
          <Alert variant="destructive" className="mt-3">
            Sign-out could not finish. Try again.
          </Alert>
        )}
      </div>
    ) : (
      <SessionVerificationMessage
        draftCleanupFailed={draftCleanupFailed}
        unavailable={unavailable}
        onRetry={retrySessionCheck}
        onSignOut={mfaRequired ? () => void signOutFromGate() : undefined}
        signOutError={signOutError}
      />
    );

  function acceptSignOut() {
    if (signOutAccepted.current) return;
    // The server has accepted sign-out. The shell owns cleanup/recovery now;
    // focus checks and responses started earlier must not replace that screen.
    signOutAccepted.current = true;
    stopActivityRenewal.current?.();
    supersedeSessionCheck(queue.current);
    curtain.current?.close();
    setChecking(false);
    setUnavailable(false);
  }

  if (verifiedUserId === null || forceFallback) {
    return (
      <main className="bg-background text-foreground grid min-h-screen place-items-center">
        <div className="w-full max-w-xl space-y-5">
          {verification}
          <MfaCleanupNotice flow={mfa} />
        </div>
      </main>
    );
  }

  return (
    <MfaFlowContext.Provider value={mfa}>
      <div
        aria-hidden={checking}
        className="contents"
        inert={checking}
        ref={protectedWorkspace}
      >
        <VerifiedWorkspaceIdentityProvider
          key={verifiedUserId}
          userId={verifiedUserId}
          suspended={checking}
        >
          <AppQueryProvider>
            <AppShell
              verifiedUserId={verifiedUserId}
              onSignOutAccepted={acceptSignOut}
            >
              <MfaCleanupNotice flow={mfa} />
              {children}
            </AppShell>
          </AppQueryProvider>
          {unavailable && !checking && (
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
      </div>
      <dialog
        aria-label="Session verification"
        className="bg-background text-foreground backdrop:bg-background fixed inset-0 m-0 h-screen max-h-none w-screen max-w-none overflow-y-auto border-0 p-0"
        onCancel={(event) => event.preventDefault()}
        ref={curtain}
      >
        <div className="grid min-h-full place-items-center">
          <div className="w-full max-w-xl space-y-5">
            {verification}
            <MfaCleanupNotice flow={mfa} />
          </div>
        </div>
      </dialog>
    </MfaFlowContext.Provider>
  );
}
