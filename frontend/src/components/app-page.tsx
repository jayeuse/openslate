"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { AppQueryProvider } from "@/components/query-provider";
import {
  clearAccessDraftsForAccountChange,
  clearVerifiedWorkspaceSessionSnapshot,
  keepAccessDraftsForVerifiedWorkspaceUser,
  VerifiedWorkspaceIdentityProvider,
  WorkspaceSignOutProvider,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  acceptOrganizationInvitation,
  getAuthMe,
  getSessionStatus,
  requestSessionRecheck,
  selectOrganization,
  sessionRecheckEvent,
  signOut,
  type OrganizationMembership,
  type PendingInvitation,
} from "@/lib/auth-api";
import {
  ApiError,
  refreshBrowserSession,
  resetBrowserSessionRefresh,
} from "@/lib/api";
import {
  currentOrganizationId,
  setCurrentOrganizationId,
} from "@/lib/organization-context";
import { subscribeIdentityChanges } from "@/lib/session-broadcast";
import { OrganizationGate } from "@/components/organization-gate";
import { toast } from "@/components/ui/toast";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  WorkspaceNavigationGuardProvider,
  GuardedWorkspaceLink,
} from "@/components/workspace-navigation-guard";
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
type GateCheck = SessionCheck | "organization";

/** The account's organizations when the session has none to open. */
type OrganizationChoice = {
  memberships: OrganizationMembership[];
  invitations: PendingInvitation[];
};

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
        <p
          className="text-muted-foreground text-center text-sm text-balance"
          role="status"
        >
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
  const [accountProfileAvailable, setAccountProfileAvailable] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [draftCleanupFailed, setDraftCleanupFailed] = useState(false);
  const [verifiedUserId, setVerifiedUserId] = useState<string | null>(null);
  const verifiedUserIdRef = useRef<string | null>(null);
  // The organization the mounted workspace belongs to. The workspace (its
  // query cache, preferences owner and event stream) is keyed by account and
  // organization, so a switch starts from an empty cache.
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [accountOnly, setAccountOnly] = useState(false);
  const organizationIdRef = useRef<string | null>(null);
  const [organizationChoice, setOrganizationChoice] =
    useState<OrganizationChoice | null>(null);
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
  const { bind: bindMfa, hide: hideMfa, clear: clearMfa, open: mfaOpen } = mfa;

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

    // Another tab signed in or out, or the session asked for a check: who is
    // signed in may have changed, so cover first, then check. A hidden tab
    // checks when it returns.
    function concealAndRecheck() {
      if (signOutAccepted.current) return;
      concealWorkspace();
      if (document.visibilityState === "visible")
        setRetryVersion((version) => version + 1);
    }

    // Leaving the window does not change who is signed in, so the workspace
    // stays visible while away. Returning covers it only while the session is
    // rechecked, which is also when features re-read roles and permissions.
    function recheckOnReturn() {
      if (signOutAccepted.current || document.visibilityState !== "visible")
        return;
      concealWorkspace();
      setRetryVersion((version) => version + 1);
    }

    // MFA setup and verification show credential material, such as the
    // authenticator QR code; hide it while the window is away.
    function concealCredentials() {
      if (mfaRequired || mfaOpen) concealWorkspace();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") recheckOnReturn();
      else concealCredentials();
    }

    window.addEventListener("blur", concealCredentials);
    window.addEventListener("focus", recheckOnReturn);
    window.addEventListener(sessionRecheckEvent, concealAndRecheck);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const stopIdentityChanges = subscribeIdentityChanges(concealAndRecheck);
    return () => {
      window.removeEventListener("blur", concealCredentials);
      window.removeEventListener("focus", recheckOnReturn);
      window.removeEventListener(sessionRecheckEvent, concealAndRecheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopIdentityChanges();
    };
  }, [hideMfa, mfaOpen, mfaRequired]);

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
        let result: GateCheck = "unavailable";
        let responseUserId: string | null = null;
        let mfaStatus: MfaStatus | null = null;
        let responseOrganizationId: string | null = null;
        let responseAccountOnly = false;
        let choice: OrganizationChoice | null = null;
        try {
          const body = await getSessionStatus(controller.signal).catch(
            (error: unknown) => {
              if (
                !mounted.current ||
                current.requestId !== requestId ||
                current.nextVersion > requested.version ||
                requested.pathname !== "/profile" ||
                currentOrganizationId() === null ||
                !(
                  error instanceof ApiError &&
                  error.status === 403 &&
                  (error.code === "ip_not_allowed" ||
                    error.code === "mfa_required")
                )
              )
                throw error;
              // A refused tab organization cannot strand account settings. Retry
              // the account's default; account-wide MFA still refuses this read.
              setCurrentOrganizationId(null);
              return getSessionStatus(controller.signal);
            },
          );
          if (
            !mounted.current ||
            current.requestId !== requestId ||
            current.controller !== controller
          )
            return;
          result = classifySessionResponse({ ok: true, status: 200 }, body);
          responseUserId = sessionUserId(body);
          // The session reports whether its default organization may be
          // entered; an explicit tab organization is refused with a 403.
          const blocked = body.authenticated
            ? body.default_organization_blocked
            : null;
          if (
            result === "valid" &&
            requested.pathname === "/profile" &&
            (blocked || (body.authenticated && body.organization_id === null))
          ) {
            const me = await getAuthMe(controller.signal);
            if (me.id !== responseUserId) result = "unavailable";
            else {
              responseOrganizationId = me.currentOrganization?.orgId ?? null;
              responseAccountOnly = me.currentOrganization === null;
            }
          } else if (result === "valid" && blocked === "mfa_required") {
            result = "mfa";
            try {
              mfaStatus = await getMfaStatus(controller.signal);
            } catch {
              mfaStatus = null;
            }
          } else if (result === "valid" && blocked === "ip_not_allowed")
            result = "network";
          else if (result === "valid") {
            responseOrganizationId = currentOrganizationId();
            const sessionOrganization = body.authenticated
              ? body.organization_id
              : undefined;
            // First check in this tab: open the session's organization, or
            // let the person choose (or see that there is none yet).
            if (responseOrganizationId === null && sessionOrganization)
              responseOrganizationId = sessionOrganization;
            else if (
              responseOrganizationId === null &&
              (sessionOrganization === null ||
                blocked === "organization_required")
            ) {
              const me = await getAuthMe(controller.signal);
              if (me.id !== responseUserId) result = "unavailable";
              else if (me.currentOrganization)
                responseOrganizationId = me.currentOrganization.orgId;
              else {
                result = "organization";
                choice = {
                  memberships: me.memberships,
                  invitations: me.pendingInvitations,
                };
              }
            }
          }
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
        // A refused tab organization may still permit account settings. This
        // offers navigation only; Profile must pass its own session recheck.
        setAccountProfileAvailable(
          responseUserId !== null ||
            (currentOrganizationId() !== null &&
              (result === "mfa" || result === "network")),
        );
        if (result === "invalid" || result === "setup") {
          setCurrentOrganizationId(null);
          organizationIdRef.current = null;
          setOrganizationChoice(null);
          resetBrowserSessionRefresh();
        }
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
        if (result === "valid" || result === "organization") {
          if (responseUserId === null) {
            setUnavailable(true);
            continue;
          }
          const previousUserId = verifiedUserIdRef.current;
          const accountChanged =
            previousUserId !== null && previousUserId !== responseUserId;
          // Another organization's drafts and notices never carry over.
          const contextChanged =
            accountChanged ||
            ((result === "valid" || requested.pathname === "/profile") &&
              previousUserId !== null &&
              organizationIdRef.current !== null &&
              organizationIdRef.current !== responseOrganizationId);
          if (contextChanged) {
            toast.clearWorkspace();
            resetBrowserSessionRefresh();
          }
          const draftsCleared = contextChanged
            ? clearAccessDraftsForAccountChange()
            : keepAccessDraftsForVerifiedWorkspaceUser(responseUserId);
          if (!draftsCleared) {
            current.queued = null;
            setVerifiedUserId(null);
            setChecking(true);
            setDraftCleanupFailed(true);
            break;
          }
          if (contextChanged) {
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
          if (result === "organization") {
            if (requested.pathname === "/profile") {
              // Verified account-only route, with a fresh cache and no shell reads.
              responseOrganizationId = null;
              responseAccountOnly = true;
            } else {
              // Keep a still-verified workspace concealed behind the choice.
              try {
                if (curtain.current && !curtain.current.open)
                  curtain.current.showModal();
              } catch {
                setForceFallback(true);
              }
              if (accountChanged) {
                organizationIdRef.current = null;
                setOrganizationId(null);
              }
              hideMfa();
              setMfaRequired(false);
              setNetworkDenied(false);
              setOrganizationChoice(choice);
              setDraftCleanupFailed(false);
              setUnavailable(false);
              setChecking(true);
              continue;
            }
          }
          setCurrentOrganizationId(responseOrganizationId);
          organizationIdRef.current = responseOrganizationId;
          setOrganizationId(responseOrganizationId);
          setAccountOnly(responseAccountOnly);
          setOrganizationChoice(null);
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
          setOrganizationChoice(null);
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
          setOrganizationChoice(null);
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
          setOrganizationChoice(null);
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
    forgetOrganization();
    void clearVerifiedWorkspaceSessionSnapshot(verifiedUserIdRef.current);
    verifiedUserIdRef.current = null;
    setVerifiedUserId(null);
    setChecking(true);
    router.replace("/login");
  }

  function forgetOrganization() {
    setCurrentOrganizationId(null);
    organizationIdRef.current = null;
    setOrganizationChoice(null);
    resetBrowserSessionRefresh();
  }

  /** Opens `orgId` in this tab. A gated organization still opens its gate. */
  async function openOrganization(
    orgId: string,
    accountId = verifiedUserIdRef.current,
  ) {
    try {
      await selectOrganization(orgId);
    } catch (caught) {
      // A refused entry (MFA, network) still opens: the gate explains it.
      if (!(caught instanceof ApiError && caught.status === 403)) throw caught;
    }
    if (signOutAccepted.current || verifiedUserIdRef.current !== accountId)
      throw new Error("The account changed while opening the organization");
    setCurrentOrganizationId(orgId);
  }

  async function chooseOrganization(organization: OrganizationMembership) {
    await openOrganization(organization.orgId);
    retrySessionCheck();
  }

  async function joinOrganization(invitation: PendingInvitation) {
    await acceptOrganizationInvitation(invitation.id);
    try {
      await openOrganization(invitation.orgId);
    } catch {
      // Joined; the next check offers the organization to choose.
    }
    retrySessionCheck();
  }

  /**
   * Switches this tab to another organization of the same account. The
   * caller has already passed the navigation guard for unsaved work.
   */
  async function switchOrganization(orgId: string): Promise<void> {
    if (
      signOutAccepted.current ||
      verifiedUserId === null ||
      verifiedUserIdRef.current !== verifiedUserId
    )
      throw new Error("The workspace account is no longer available");
    if (orgId === organizationIdRef.current) return;
    await openOrganization(orgId, verifiedUserId);
    requestSessionRecheck();
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

  const verification = organizationChoice ? (
    <OrganizationGate
      memberships={organizationChoice.memberships}
      invitations={organizationChoice.invitations}
      onChoose={chooseOrganization}
      onJoin={joinOrganization}
      onCheckAgain={retrySessionCheck}
      onSignOut={() => void signOutFromGate()}
      signOutError={signOutError}
    />
  ) : mfaRequired && mfa.mode === "gate" ? (
    <section
      className="w-full max-w-lg px-6 py-8"
      aria-label="Two-step verification"
    >
      <h2 className="text-xl font-semibold">Complete two-step verification</h2>
      <p className="text-muted-foreground mt-2 text-sm">
        Verify this account before continuing to your workspace.
      </p>
      <MfaPresentation flow={mfa} gate />
      <div className="mt-2 flex flex-wrap gap-3">
        {accountProfileAvailable && (
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/profile">Your profile</Link>
          </Button>
        )}
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
        {accountProfileAvailable && (
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/profile">Your profile</Link>
          </Button>
        )}
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
    forgetOrganization();
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
          key={`${verifiedUserId}:${organizationId}`}
          userId={verifiedUserId}
          organizationId={organizationId}
          suspended={checking}
        >
          <AppQueryProvider>
            {accountOnly ? (
              <WorkspaceNavigationGuardProvider
                onAcceptedNavigation={() => undefined}
              >
                <WorkspaceSignOutProvider
                  complete={async () => finishFactorRemoval()}
                >
                  <main className="bg-background text-foreground min-h-screen px-4 py-6 sm:px-8">
                    <div className="mx-auto max-w-5xl space-y-6">
                      <Button asChild variant="outline" className="min-h-11">
                        <GuardedWorkspaceLink href="/boards">
                          Your organizations
                        </GuardedWorkspaceLink>
                      </Button>
                      <MfaCleanupNotice flow={mfa} />
                      {pathname === "/profile" ? children : null}
                    </div>
                  </main>
                </WorkspaceSignOutProvider>
              </WorkspaceNavigationGuardProvider>
            ) : (
              <AppShell
                verifiedUserId={verifiedUserId}
                organizationId={organizationId}
                onSwitchOrganization={switchOrganization}
                onSignOutAccepted={acceptSignOut}
              >
                <MfaCleanupNotice flow={mfa} />
                {children}
              </AppShell>
            )}
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
