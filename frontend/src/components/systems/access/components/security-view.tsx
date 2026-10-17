"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import { useMfaFlow } from "@/components/mfa-flow";
import {
  registerWorkspaceSessionClear,
  useVerifiedWorkspaceUserId,
} from "@/components/systems/shared/runtime/workspace-identity";
import { manageKeys } from "../../manage/adapters/manage-queries";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  accessAdminSessionsOptions,
  accessKeys,
  accessSecurityOptions,
  afterAccessAdminSessionsChange,
  afterAccessMfaObservation,
  afterAccessSecurityChange,
  isAccessSecurityDenied,
  setAccessSecurityDenied,
} from "../adapters/access-queries";
import {
  defaultAccessSessionsRequest,
  endAccessSession,
  endAllAccessRemoteSessions,
  getAccessCallerIp,
  securityNetworkKey,
  securitySettingsFormErrors,
  securitySettingsFormFields,
  securitySettingsPatch,
  updateAccessSecurityPolicy,
  validSecurityNetwork,
  type AccessSecurityPolicy,
  type AccessAdminSession,
  type SecuritySettingsFormFields,
  type SecuritySettingsFormErrors,
  type SecuritySettingsFormDraft,
} from "../adapters/security-api";
import {
  AccessConfirmationDialog,
  AccessMfaDialog,
  type ConfirmState,
} from "./security-dialogs";
import { SecurityPanel, SecurityPolicyForm } from "./security-panel";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";

function policySummary(
  fields: SecuritySettingsFormFields,
  requiredRoles: string,
) {
  const [amount, unit = ""] = fields.timeout.split(" ");
  return [
    `${fields.minimumLength}-character password minimum`,
    requiredRoles
      ? `Two-step verification required for ${requiredRoles}`
      : "Two-step verification optional",
    `${amount}-${unit.replace(/s$/, "")} timeout`,
    fields.absoluteLifetime !== "Off"
      ? `${fields.absoluteLifetime}-minute session lifetime`
      : null,
    fields.concurrentLimit !== "Off"
      ? `Up to ${fields.concurrentLimit} sessions`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type SecurityViewProps = {
  active: boolean;
  admitted: boolean;
  onBusyChange: (busy: boolean) => void;
};
type Operation = {
  controller: AbortController;
  epoch: number;
  writing: boolean;
};

/** Account-local draft/commands survive a same-account privacy curtain. */
export function SecurityView({
  active,
  admitted,
  onBusyChange,
}: SecurityViewProps) {
  const queryClient = useQueryClient();
  const userId = useVerifiedWorkspaceUserId();
  const ownsMfa = useRef(false);
  const previousActive = useRef(active);
  const [securityDraft, setSecurityDraft] = useState<SecuritySettingsFormDraft>(
    {},
  );
  const [securityStale, setSecurityStale] = useState(false);
  const [securityRefreshRequired, setSecurityRefreshRequired] = useState(false);
  const [livePending, setLivePending] = useState(false);
  const [sessionRequest, setSessionRequest] = useState(
    defaultAccessSessionsRequest,
  );
  const [policyOpen, setPolicyOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [draftAcknowledged, setDraftAcknowledged] = useState(false);
  const [error, setError] = useState("");
  const [formErrors, setFormErrors] = useState<SecuritySettingsFormErrors>({});
  const [addressNotice, setAddressNotice] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const epoch = useRef(0);
  const operation = useRef<Operation | null>(null);
  const admission = useRef({ active, admitted });
  const needsReadback = useRef(false);
  const policyOpener = useRef<HTMLButtonElement | null>(null);
  const mfaOpener = useRef<HTMLButtonElement | null>(null);
  const confirmOpener = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const refusalRechecked = useRef(false);
  const mfa = useMfaFlow();
  const mfaFactorId = mfa.credentials?.id ?? null;
  const observedMfa = useRef({
    userId,
    status: mfa.status,
    factorId: mfaFactorId,
  });
  const cancelMfa = mfa.cancel;
  const securityDenied = isAccessSecurityDenied(queryClient, "policy");
  const sessionsDenied = isAccessSecurityDenied(queryClient, "sessions");
  const eventsDenied = isAccessSecurityDenied(queryClient, "events");
  const identity = useQuery(authMeOptions());
  // Read-only until /auth/me confirms the owner flags; the server enforces them.
  const editable = {
    organization: Boolean(
      identity.data?.organizationOwner || identity.data?.operator,
    ),
    installation: Boolean(identity.data?.operator),
  };
  const securityQuery = useQuery({
    ...accessSecurityOptions(queryClient),
    enabled: active && admitted && !securityDenied,
  });
  const sessionsQuery = useQuery({
    ...accessAdminSessionsOptions(queryClient, sessionRequest),
    enabled: active && admitted && !sessionsDenied,
  });
  const securityFields =
    securityQuery.data && !securityDenied
      ? securitySettingsFormFields(securityQuery.data)
      : null;
  const requiredMfaRoles = securityFields
    ? [
        securityFields.requireMfaAdmin ? "administrators" : null,
        securityFields.requireMfaMember ? "members" : null,
        securityFields.requireMfaGuest ? "guests" : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  const securityPatch = securityQuery.data
    ? securitySettingsPatch(securityQuery.data, securityDraft)
    : null;
  const securityDirty =
    securityPatch !== null ||
    Boolean(securityDraft.ipEntry) ||
    (!securityQuery.data && Object.keys(securityDraft).length > 0);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      operation.current?.controller.abort();
      operation.current = null;
    };
  }, []);
  useEffect(() => {
    if (!active || !admitted) return;
    const previous = observedMfa.current;
    observedMfa.current = { userId, status: mfa.status, factorId: mfaFactorId };
    if (previous.userId !== userId) return;
    const acceptedStatus =
      mfa.status?.user_id === userId && mfa.status !== previous.status;
    const acceptedEnrollment =
      mfa.status?.user_id === userId &&
      mfaFactorId !== null &&
      mfaFactorId !== previous.factorId;
    // The existing controller clears both values after accepted verification,
    // before its fresh status read, which may fail. A cancel retains status.
    const acceptedVerification =
      previous.status?.user_id === userId &&
      previous.factorId !== null &&
      mfaFactorId === null &&
      mfa.status === null;
    if (acceptedStatus || acceptedEnrollment || acceptedVerification)
      void afterAccessMfaObservation(queryClient);
  }, [active, admitted, mfa.status, mfaFactorId, queryClient, userId]);
  useEffect(
    () =>
      registerWorkspaceSessionClear(userId, () => {
        // The shell owns identity-transition cleanup before binding the next user.
        ownsMfa.current = false;
      }),
    [userId],
  );
  useLayoutEffect(() => {
    if (!mfa.open) ownsMfa.current = false;
  }, [mfa.open]);
  useEffect(
    () => () => {
      if (ownsMfa.current) cancelMfa();
    },
    [cancelMfa],
  );
  useEffect(() => {
    if (previousActive.current && !active && ownsMfa.current) {
      ownsMfa.current = false;
      cancelMfa();
    }
    previousActive.current = active;
  }, [active, cancelMfa]);
  useLayoutEffect(() => {
    const previous = admission.current;
    admission.current = { active, admitted };
    if ((!active || !admitted) && previous.active && previous.admitted) {
      epoch.current += 1;
      if (!admitted || operation.current?.writing) {
        needsReadback.current = true;
        setSecurityRefreshRequired(true);
      }
      operation.current?.controller.abort();
      operation.current = null;
      setLivePending(false);
      onBusyChange(false);
      void queryClient.cancelQueries({ queryKey: accessKeys.security() });
      void queryClient.cancelQueries({ queryKey: accessKeys.adminSessions() });
      void queryClient.cancelQueries({ queryKey: accessKeys.securityEvents() });
    }
  }, [active, admitted, onBusyChange, queryClient]);
  useEffect(() => {
    for (const [denied, queryKey] of [
      [securityDenied, accessKeys.security()],
      [sessionsDenied, accessKeys.adminSessions()],
      [eventsDenied, accessKeys.securityEvents()],
    ] as const) {
      if (denied)
        void queryClient
          .cancelQueries({ queryKey })
          .then(() => queryClient.removeQueries({ queryKey }));
    }
    if (sessionsDenied) setConfirm(null);
  }, [securityDenied, sessionsDenied, eventsDenied, queryClient]);
  useEffect(() => {
    if (!active || !admitted) return;
    if (!securityDenied && !sessionsDenied && !eventsDenied) {
      refusalRechecked.current = false;
      return;
    }
    if (!refusalRechecked.current) {
      let current = true;
      const readEpoch = epoch.current;
      queueMicrotask(() => {
        if (
          !current ||
          !mounted.current ||
          !admission.current.active ||
          !admission.current.admitted ||
          epoch.current !== readEpoch ||
          refusalRechecked.current ||
          (!isAccessSecurityDenied(queryClient, "policy") &&
            !isAccessSecurityDenied(queryClient, "sessions") &&
            !isAccessSecurityDenied(queryClient, "events"))
        )
          return;
        refusalRechecked.current = true;
        requestSessionRecheck();
      });
      return () => {
        current = false;
      };
    }
  }, [
    active,
    admitted,
    securityDenied,
    sessionsDenied,
    eventsDenied,
    queryClient,
  ]);

  function clearDraft() {
    if (operation.current) return false;
    setSecurityDraft({});
    setSecurityStale(false);
    setSecurityRefreshRequired(false);
    setError("");
    setFormErrors({});
    setAddressNotice("");
    setNotice("Unsaved changes discarded.");
    return true;
  }
  useAccessDraftRegistration("security-policy", securityDirty, clearDraft);

  const begin = useCallback(
    (writing: boolean) => {
      if (
        !mounted.current ||
        !admission.current.active ||
        !admission.current.admitted ||
        operation.current
      )
        return null;
      const next = {
        controller: new AbortController(),
        epoch: epoch.current,
        writing,
      };
      operation.current = next;
      setLivePending(true);
      onBusyChange(true);
      return next;
    },
    [onBusyChange],
  );
  const owns = useCallback((next: Operation) => {
    return (
      mounted.current &&
      operation.current === next &&
      epoch.current === next.epoch &&
      admission.current.active &&
      admission.current.admitted &&
      !next.controller.signal.aborted
    );
  }, []);
  const finish = useCallback(
    (next: Operation) => {
      if (!owns(next)) return;
      operation.current = null;
      setLivePending(false);
      onBusyChange(false);
    },
    [onBusyChange, owns],
  );
  function changeSetting<K extends keyof SecuritySettingsFormFields>(
    key: K,
    value: SecuritySettingsFormFields[K],
  ) {
    if (
      !admission.current.active ||
      !admission.current.admitted ||
      operation.current ||
      securityDenied
    )
      return;
    setSecurityDraft((draft) => {
      const next = { ...draft, [key]: value };
      if (
        securityFields &&
        JSON.stringify(value) === JSON.stringify(securityFields[key])
      )
        delete next[key];
      return next;
    });
    setNotice("");
    setError("");
    setFormErrors((errors) => ({ ...errors, [key]: undefined }));
    setAddressNotice("");
  }
  function addAddress() {
    if (
      !securityFields ||
      operation.current ||
      !admission.current.active ||
      !admission.current.admitted ||
      securityDenied
    )
      return;
    const address = (securityDraft.ipEntry ?? "").trim();
    if (!validSecurityNetwork(address)) {
      setFormErrors((errors) => ({
        ...errors,
        ipEntry: "Enter a valid IP address or CIDR range.",
      }));
      return;
    }
    const ips = securityDraft.ips ?? securityFields.ips;
    const duplicate = ips.some(
      (value) => securityNetworkKey(value) === securityNetworkKey(address),
    );
    if (!duplicate && ips.length >= 100) {
      setFormErrors((errors) => ({
        ...errors,
        ipEntry: "You can add up to 100 addresses or ranges.",
      }));
      return;
    }
    if (!duplicate) changeSetting("ips", [...ips, address]);
    changeSetting("ipEntry", "");
  }
  async function addMyAddress() {
    if (
      !securityFields ||
      securityDenied ||
      securityQuery.isError ||
      securityRefreshRequired
    )
      return;
    const next = begin(false);
    if (!next) return;
    setError("");
    setAddressNotice("");
    try {
      const { address } = await getAccessCallerIp(next.controller.signal);
      if (!owns(next)) return;
      const policy = queryClient.getQueryData<AccessSecurityPolicy>(
        accessKeys.security(),
      );
      const ips =
        securityDraft.ips ?? policy?.ip_allow_list ?? securityFields.ips;
      const duplicate = ips.some(
        (value) => securityNetworkKey(value) === securityNetworkKey(address),
      );
      if (!duplicate && ips.length >= 100) {
        setError(
          "You can add up to 100 addresses or ranges. Remove one before adding your address.",
        );
        return;
      }
      if (!duplicate) {
        setSecurityDraft((draft) => ({ ...draft, ips: [...ips, address] }));
      }
      setAddressNotice(
        duplicate
          ? "Your address is already in the list."
          : "Your address was added to the draft. Save settings to apply it.",
      );
    } catch (caught) {
      if (!owns(next)) return;
      if (
        caught instanceof ApiError &&
        (caught.status === 401 || caught.status === 403)
      ) {
        if (caught.status === 403) {
          setAccessSecurityDenied(queryClient, "policy", true);
          setAccessSecurityDenied(queryClient, "sessions", true);
        }
        requestSessionRecheck();
      }
      setError(
        "Your current address could not be loaded. Your changes are still here; add an address manually or try again.",
      );
    } finally {
      finish(next);
    }
  }
  async function retrySecurity() {
    const next = begin(false);
    if (!next) return;
    setError("");
    try {
      await queryClient.cancelQueries({ queryKey: accessKeys.security() });
      await queryClient.fetchQuery({
        ...accessSecurityOptions(queryClient),
        staleTime: 0,
      });
      if (!owns(next)) return;
      setAccessSecurityDenied(queryClient, "policy", false);
      setSecurityRefreshRequired(false);
    } catch {
      if (owns(next))
        setError("Account policy could not be loaded. Retry before saving.");
    } finally {
      finish(next);
    }
  }
  async function retrySessions() {
    const next = begin(false);
    if (!next) return;
    try {
      await queryClient.cancelQueries({ queryKey: accessKeys.adminSessions() });
      await queryClient.fetchQuery({
        ...accessAdminSessionsOptions(queryClient, sessionRequest),
        staleTime: 0,
      });
      if (owns(next)) setAccessSecurityDenied(queryClient, "sessions", false);
    } catch {
      if (owns(next)) setError("Sessions could not be loaded. Try again.");
    } finally {
      finish(next);
    }
  }
  useEffect(() => {
    if (!active || !admitted || !needsReadback.current || operation.current)
      return;
    const next = begin(false);
    if (!next) return;
    needsReadback.current = false;
    void Promise.all([
      queryClient.cancelQueries({ queryKey: accessKeys.security() }),
      queryClient.cancelQueries({ queryKey: accessKeys.adminSessions() }),
    ])
      .then(async () => {
        if (!owns(next)) return;
        const [policy] = await Promise.allSettled([
          isAccessSecurityDenied(queryClient, "policy")
            ? Promise.resolve(null)
            : queryClient.fetchQuery({
                ...accessSecurityOptions(queryClient),
                staleTime: 0,
              }),
          isAccessSecurityDenied(queryClient, "sessions")
            ? Promise.resolve(null)
            : queryClient.fetchQuery({
                ...accessAdminSessionsOptions(queryClient, sessionRequest),
                staleTime: 0,
              }),
        ]);
        if (!owns(next)) return;
        if (
          policy.status === "fulfilled" &&
          policy.value !== null &&
          !isAccessSecurityDenied(queryClient, "policy")
        ) {
          setSecurityRefreshRequired(false);
        } else setSecurityRefreshRequired(true);
      })
      .finally(() => finish(next));
  }, [active, admitted, queryClient, sessionRequest, begin, finish, owns]);

  async function saveSection() {
    if (
      !securityQuery.data ||
      securityDenied ||
      securityQuery.isError ||
      securityRefreshRequired
    )
      return;
    const validation = securitySettingsFormErrors({
      ...securitySettingsFormFields(securityQuery.data),
      ...securityDraft,
    });
    setFormErrors(validation);
    if (Object.keys(validation).length > 0) return;
    const patch = securitySettingsPatch(securityQuery.data, securityDraft);
    if (!patch) {
      setSecurityDraft({});
      setAddressNotice("");
      return;
    }
    const next = begin(true);
    if (!next) return;
    setError("");
    setNotice("");
    try {
      // Consuming the query signal makes cancellation definitive: an older GET
      // cannot replace the confirmed revision/draft after this PATCH.
      await queryClient.cancelQueries({ queryKey: accessKeys.security() });
      if (!owns(next)) return;
      const saved = await updateAccessSecurityPolicy(
        patch,
        next.controller.signal,
      );
      if (!owns(next)) return;
      afterAccessSecurityChange(queryClient, saved);
      void queryClient.invalidateQueries({ queryKey: manageKeys.workspace() });
      setSecurityDraft({});
      setFormErrors({});
      setAddressNotice("");
      setSecurityStale(false);
      setSecurityRefreshRequired(false);
      setNotice("Account policy saved.");
      requestSessionRecheck();
    } catch (caught) {
      if (!owns(next)) return;
      if (
        caught instanceof ApiError &&
        caught.status === 409 &&
        caught.code === "stale_revision"
      ) {
        setSecurityStale(true);
        setSecurityRefreshRequired(true);
        try {
          await queryClient.fetchQuery({
            ...accessSecurityOptions(queryClient),
            staleTime: 0,
          });
          if (owns(next)) setSecurityRefreshRequired(false);
        } catch {
          if (owns(next))
            setError(
              "The latest policy could not be loaded. Retry before saving again.",
            );
        }
      } else {
        if (
          caught instanceof ApiError &&
          (caught.status === 401 || caught.status === 403)
        ) {
          if (caught.status === 403) {
            setAccessSecurityDenied(queryClient, "policy", true);
            setAccessSecurityDenied(queryClient, "sessions", true);
          }
          requestSessionRecheck();
        }
        setError(
          caught instanceof ApiError &&
            caught.status === 409 &&
            caught.code === "mfa_enrollment_required"
            ? "Set up two-step verification for your own account before you require it for every role. Your changes are still here. Choose Manage two-step verification, then save again."
            : caught instanceof ApiError && caught.code === "ip_lockout"
              ? "The IP allow list would block your current address. Include your current address before saving."
              : caught instanceof ApiError && caught.status === 422
                ? "Check the policy values and IP addresses. Your changes are still here."
                : caught instanceof ApiError && caught.status === 403
                  ? "Only administrators can change account policy. Reload the page to check your access."
                  : "The policy could not be saved. Try again.",
        );
        if (caught instanceof ApiError && caught.code === "ip_lockout") {
          // The error belongs to the allow list: show it there and move focus.
          setFormErrors((errors) => ({
            ...errors,
            ips: "This list blocks your current address. Add your address, then save.",
          }));
          requestAnimationFrame(() =>
            document.getElementById("ip-entry")?.focus(),
          );
        }
      }
    } finally {
      finish(next);
    }
  }
  async function runSessionEnd(
    action: (signal: AbortSignal) => Promise<null>,
    all: boolean,
  ) {
    if (sessionsDenied || sessionsQuery.isError) return false;
    const next = begin(true);
    if (!next) return false;
    setError("");
    setNotice("");
    try {
      await action(next.controller.signal);
      if (!owns(next)) return false;
      await afterAccessAdminSessionsChange(queryClient);
      if (!owns(next)) return false;
      setSessionRequest((request) => ({ ...request, offset: 0 }));
      setNotice(
        all
          ? "Remote sessions ended. Your current session stays active."
          : "Session ended.",
      );
      return true;
    } catch (caught) {
      if (owns(next)) {
        if (
          caught instanceof ApiError &&
          (caught.status === 401 || caught.status === 403)
        ) {
          if (caught.status === 403)
            setAccessSecurityDenied(queryClient, "sessions", true);
          requestSessionRecheck();
        }
        setError(
          all
            ? "Remote sessions could not be ended. Try again."
            : "The session could not be ended. Try again.",
        );
      }
      return false;
    } finally {
      finish(next);
    }
  }
  function requestConfirm(next: ConfirmState, event: MouseEvent<HTMLElement>) {
    if (
      operation.current ||
      sessionsDenied ||
      sessionsQuery.isError ||
      !admission.current.active ||
      !admission.current.admitted
    )
      return;
    confirmOpener.current = event.currentTarget;
    setDraftAcknowledged(false);
    setError("");
    setConfirm(next);
  }
  function endSession(
    session: AccessAdminSession,
    event: MouseEvent<HTMLElement>,
  ) {
    if (session.current) return;
    requestConfirm(
      {
        origin: "admin-sessions",
        title: "End session",
        description: `${session.person_name}'s ${session.device} ${session.browser} session will be signed out. Your current session stays active.`,
        confirmLabel: "Confirm end session",
        action: () =>
          runSessionEnd((signal) => endAccessSession(session, signal), false),
      },
      event,
    );
  }
  function endAllRemoteSessions(event: MouseEvent<HTMLElement>) {
    requestConfirm(
      {
        origin: "admin-sessions",
        title: "End all remote sessions",
        description:
          "End all other active sessions across the organization? Your current session stays active.",
        confirmLabel: "Confirm end all remote sessions",
        action: () => runSessionEnd(endAllAccessRemoteSessions, true),
      },
      event,
    );
  }
  function openMfa() {
    ownsMfa.current = true;
    mfa.openManage();
  }
  if (!active || !admitted) return null;
  return (
    <section aria-label="Security workspace" className="min-w-0 space-y-5">
      {notice ? (
        <Alert role="status" variant="success">
          {notice}
        </Alert>
      ) : null}
      {error && !policyOpen && !confirm ? (
        <Alert role="alert" variant="destructive">
          {error}
        </Alert>
      ) : null}
      <fieldset disabled={livePending} className="min-w-0 space-y-5">
        <div className="bg-card flex flex-wrap items-center gap-4 rounded-lg border p-5">
          <LockKeyhole
            aria-hidden="true"
            className="text-muted-foreground size-6 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                ref={headingRef}
                tabIndex={-1}
                data-slot="section-title"
                className="font-semibold"
              >
                Account policy
              </h2>
              {securityDirty ? (
                <Badge variant="warning">Unsaved changes</Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              {securityFields
                ? policySummary(securityFields, requiredMfaRoles)
                : securityQuery.isPending && !securityDenied
                  ? "Loading policy…"
                  : "Account policy unavailable"}
            </p>
          </div>
          <Button
            ref={policyOpener}
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setError("");
              setPolicyOpen(true);
            }}
          >
            {editable.organization ? "Edit policy" : "View policy"}
          </Button>
        </div>
        <SecurityPanel
          sessions={
            sessionsDenied
              ? {
                  status: "error",
                  message: "Only administrators can review sessions.",
                }
              : sessionsQuery.isPending
                ? { status: "loading" }
                : sessionsQuery.isError
                  ? {
                      status: "error",
                      message: "Sessions could not be loaded.",
                      page: sessionsQuery.data,
                    }
                  : { status: "ready", page: sessionsQuery.data }
          }
          request={sessionRequest}
          onRequestChange={(request) => {
            if (!operation.current) setSessionRequest(request);
          }}
          onRetry={() => void retrySessions()}
          actions={{ endSession, endAllRemoteSessions }}
        />
        <GuardedWorkspaceLink
          href="/manage?view=audit&audit=security-events"
          className="text-primary focus-visible:outline-ring inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
          aria-disabled={livePending}
          onClick={(event) => {
            if (livePending) event.preventDefault();
          }}
        >
          View security events in Audit
        </GuardedWorkspaceLink>
      </fieldset>
      <Dialog
        open={policyOpen}
        onOpenChange={(open) => {
          if (!livePending) setPolicyOpen(open);
        }}
        dismissible={!livePending}
      >
        <DialogContent
          className="max-w-3xl"
          finalFocus={() => policyOpener.current}
        >
          <DialogHeader className="mb-5">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Account policy</DialogTitle>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close account policy"
                disabled={livePending}
                onClick={() => setPolicyOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <DialogDescription>
              {editable.organization
                ? "Set the account policy enforced by your organization. Closing keeps your unsaved changes."
                : "Review the account policy enforced by your organization."}
            </DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={livePending}
            aria-busy={livePending}
            className="min-w-0 space-y-4"
          >
            {error ? (
              <Alert role="alert" variant="destructive">
                {error}
              </Alert>
            ) : null}
            {securityStale ? (
              <Alert role="note" variant="warning">
                Policy changed since you opened it. Your draft is kept; review
                the latest values before saving again.
              </Alert>
            ) : null}
            {securityQuery.isPending && !securityDenied ? (
              <p role="status">Loading account policy…</p>
            ) : null}
            {securityDenied ||
            securityQuery.isError ||
            securityRefreshRequired ? (
              <Alert role="alert" variant="destructive">
                <p>
                  {securityDenied
                    ? "Only administrators can review account policy."
                    : "Account policy could not be loaded."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void retrySecurity()}
                >
                  Retry account policy
                </Button>
              </Alert>
            ) : null}
            {securityFields ? (
              <SecurityPolicyForm
                form={{
                  dirty: securityDirty,
                  saved: securityFields,
                  current: {
                    ...securityFields,
                    ...securityDraft,
                  },
                  errors: formErrors,
                  addAddress,
                  addMyAddress,
                  addressNotice,
                  saveSection,
                  clearDraft,
                  changeSetting,
                }}
                editable={editable}
                onManageMfa={() => {
                  setPolicyOpen(false);
                  openMfa();
                  mfaOpener.current = policyOpener.current;
                }}
              />
            ) : null}
          </fieldset>
        </DialogContent>
      </Dialog>
      <AccessMfaDialog opener={mfaOpener} />
      <AccessConfirmationDialog
        confirm={sessionsDenied ? null : confirm}
        pending={livePending}
        actionsDisabled={sessionsDenied || sessionsQuery.isError}
        error={error}
        draftAcknowledged={draftAcknowledged}
        confirmOpener={confirmOpener}
        headingRef={headingRef}
        onClose={() => setConfirm(null)}
        onDraftAcknowledgedChange={setDraftAcknowledged}
      />
    </section>
  );
}
