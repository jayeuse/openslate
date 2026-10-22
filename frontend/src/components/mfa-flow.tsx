"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiError } from "@/lib/api";
import {
  cancelMfaEnrollment,
  enrollMfa,
  getMfaStatus,
  removeMfa,
  verifyMfa,
  type MfaEnrollment,
  type MfaStatus,
} from "@/lib/mfa-api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import {
  formatWorkspaceDateTime,
  type WorkspaceRegion,
} from "@/lib/date-time-display";
type OwnedFactor = { userId: string; factorId: string };
type Mode = "hidden" | "workspace" | "gate";
const cleanupMessage =
  "Setup closed, but the unfinished authenticator could not be removed. Retry cleanup.";
export function useMfaController(onRecheck: () => void, onRemoved: () => void) {
  const [mode, setMode] = useState<Mode>("hidden");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [credentials, setCredentials] = useState<MfaEnrollment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [cleanup, setCleanup] = useState<OwnedFactor | null>(null);
  const [cleanupError, setCleanupError] = useState("");
  const owner = useRef<string | null>(null);
  const owned = useRef<OwnedFactor | null>(null);
  const generation = useRef(0);
  const enrolling = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onRecheck, onRemoved });
  useEffect(() => {
    callbacks.current = { onRecheck, onRemoved };
  }, [onRecheck, onRemoved]);

  const cleanOwned = useCallback(async (target: OwnedFactor) => {
    try {
      const current = await getMfaStatus();
      if (current.user_id !== target.userId) {
        if (mounted.current)
          setCleanupError(
            "The account changed before setup could be removed. Sign back in to check unfinished setup, or contact your administrator.",
          );
        return;
      }
      const factorId = target.factorId;
      const factor = current.factors.find((entry) => entry.id === factorId);
      if (factor?.status === "unverified") await cancelMfaEnrollment(factorId);
      if (mounted.current) {
        setCleanup(null);
        setCleanupError("");
      }
    } catch {
      if (mounted.current) {
        setCleanup(target);
        setCleanupError(cleanupMessage);
      } else
        toast.addPublic({
          type: "error",
          title: "Authenticator cleanup could not finish",
          description:
            "Sign back in to check unfinished setup, or contact your administrator.",
        });
    }
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    const target = owned.current;
    owned.current = null;
    setCredentials(null);
    setOpen(false);
    setPending(false);
    setError("");
    if (target) void cleanOwned(target);
  }, [cleanOwned]);

  const bind = useCallback(
    (userId: string, nextMode: Mode, current?: MfaStatus) => {
      if (owner.current !== userId) {
        const target = owned.current;
        generation.current += 1;
        owned.current = null;
        owner.current = userId;
        setCredentials(null);
        setOpen(false);
        setPending(false);
        setError("");
        setStatus(current ?? null);
        setCleanup(null);
        setCleanupError("");
        if (target) void cleanOwned(target);
      } else if (current) setStatus(current);
      setMode(nextMode);
    },
    [cleanOwned],
  );

  const hide = useCallback(() => setMode("hidden"), []);
  const clear = useCallback(() => {
    cancel();
    owner.current = null;
    setStatus(null);
    setMode("hidden");
  }, [cancel]);

  const refresh = useCallback(async () => {
    const started = generation.current;
    setPending(true);
    setError("");
    try {
      const current = await getMfaStatus();
      if (!mounted.current || started !== generation.current) return;
      if (current.user_id !== owner.current) {
        hide();
        callbacks.current.onRecheck();
        return;
      }
      setStatus(current);
    } catch {
      if (mounted.current && started === generation.current)
        setError(
          "We could not load your two-step verification settings. Try again.",
        );
    } finally {
      if (mounted.current && started === generation.current) setPending(false);
    }
  }, [hide]);

  const openManage = useCallback(() => {
    setOpen(true);
    void refresh();
  }, [refresh]);
  const enroll = useCallback(async () => {
    if (enrolling.current || owned.current || owner.current === null) return;
    const userId = owner.current;
    const started = generation.current;
    enrolling.current = true;
    setPending(true);
    setError("");
    try {
      const result = await enrollMfa();
      const target = { userId, factorId: result.id };
      if (
        !mounted.current ||
        started !== generation.current ||
        owner.current !== userId
      ) {
        // Drop the credential payload before any asynchronous cleanup.
        result.totp.qr_code = "";
        result.totp.secret = "";
        result.totp.uri = "";
        await cleanOwned(target);
        return;
      }
      owned.current = target;
      setCredentials(result);
    } catch {
      if (mounted.current && started === generation.current)
        setError("The authenticator could not be set up. Try again.");
    } finally {
      enrolling.current = false;
      if (mounted.current && started === generation.current) setPending(false);
    }
  }, [cleanOwned]);

  const verify = useCallback(
    async (factorId: string, code: string) => {
      const started = generation.current;
      const userId = owner.current;
      let accepted = false;
      setPending(true);
      setError("");
      try {
        await verifyMfa(factorId, code);
        accepted = true;
        if (
          !mounted.current ||
          started !== generation.current ||
          owner.current !== userId
        )
          return;
        owned.current = null;
        setCredentials(null);
        setStatus(null);
        callbacks.current.onRecheck();
        const current = await getMfaStatus();
        if (
          !mounted.current ||
          started !== generation.current ||
          owner.current !== userId
        )
          return;
        if (current.user_id !== userId) {
          hide();
          callbacks.current.onRecheck();
          return;
        }
        setStatus(current);
      } catch (caught) {
        if (mounted.current && started === generation.current)
          setError(
            accepted
              ? "Verification succeeded, but your updated settings could not load. Retry."
              : caught instanceof ApiError && caught.status === 400
                ? "Verification code was not accepted. Enter a new code and try again."
                : "The code could not be verified. Try again.",
          );
      } finally {
        if (mounted.current && started === generation.current)
          setPending(false);
      }
    },
    [hide],
  );

  const removeVerified = useCallback(async (factorId: string) => {
    const started = generation.current;
    const userId = owner.current;
    setPending(true);
    setError("");
    try {
      await removeMfa(factorId);
      if (
        !mounted.current ||
        started !== generation.current ||
        owner.current !== userId
      )
        return;
      setCredentials(null);
      callbacks.current.onRemoved();
    } catch {
      if (mounted.current && started === generation.current)
        setError("The authenticator could not be removed. Try again.");
    } finally {
      if (mounted.current && started === generation.current) setPending(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      const target = owned.current;
      owned.current = null;
      if (target) void cleanOwned(target);
    };
  }, [cleanOwned]);

  return {
    mode,
    open,
    status,
    credentials,
    pending,
    error,
    cleanupError,
    bind,
    hide,
    clear,
    openManage,
    cancel,
    refresh,
    enroll,
    verify,
    removeVerified,
    retryCleanup: () => {
      if (cleanup) void cleanOwned(cleanup);
    },
    cleanupRetryable: cleanup !== null,
  };
}

export type MfaFlow = ReturnType<typeof useMfaController>;
export const MfaFlowContext = createContext<MfaFlow | null>(null);
export function useMfaFlow() {
  const flow = useContext(MfaFlowContext);
  if (!flow) throw new Error("MFA flow is unavailable");
  return flow;
}

export function MfaCleanupNotice({ flow }: { flow: MfaFlow }) {
  return flow.cleanupError ? (
    <Alert role="alert" variant="destructive" className="mb-5">
      <p>{flow.cleanupError}</p>
      {flow.cleanupRetryable && (
        <Button
          className="mt-3 min-h-11"
          variant="outline"
          onClick={flow.retryCleanup}
        >
          Retry cleanup
        </Button>
      )}
    </Alert>
  ) : null;
}

/** Workspace-local when the workspace region is known; else this device's zone. */
function requirementDate(value: string, region: WorkspaceRegion | undefined) {
  if (region)
    return formatWorkspaceDateTime(value, region, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}
function utcTitle(value: string) {
  return (
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}

export function MfaPresentation({
  flow,
  gate = false,
  region,
}: {
  flow: MfaFlow;
  gate?: boolean;
  /** The workspace region; absent before two-step verification completes. */
  region?: WorkspaceRegion;
}) {
  const [code, setCode] = useState("");
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const verified = flow.status?.factors.find(
    (entry) => entry.factor_type === "totp" && entry.status === "verified",
  );
  const factorId = flow.credentials?.id ?? verified?.id;
  const ready =
    flow.status?.assurance_level === "aal2" &&
    verified !== undefined &&
    flow.credentials === null;
  const step = ready ? 3 : factorId ? 2 : 1;
  const requirement = flow.status?.policy_required ? flow.status : null;
  return (
    <div className="flex min-w-0 flex-col gap-4 py-2">
      <Progress
        value={step}
        max={3}
        aria-label="Two-step verification setup progress"
      />
      <p className="text-muted-foreground text-sm">
        Step {step} of 3 · Authenticator app
      </p>
      {requirement && (
        <div className="min-w-0 space-y-3">
          {(requirement.required_since || requirement.enrollment_deadline) && (
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              {requirement.required_since && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Required since</dt>
                  <dd className="mt-1 break-words tabular-nums">
                    <time
                      dateTime={requirement.required_since}
                      title={utcTitle(requirement.required_since)}
                    >
                      {requirementDate(requirement.required_since, region)}
                    </time>
                  </dd>
                </div>
              )}
              {requirement.enrollment_deadline && (
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Set up by</dt>
                  <dd className="mt-1 break-words tabular-nums">
                    <time
                      dateTime={requirement.enrollment_deadline}
                      title={utcTitle(requirement.enrollment_deadline)}
                    >
                      {requirementDate(requirement.enrollment_deadline, region)}
                    </time>
                  </dd>
                </div>
              )}
            </dl>
          )}
          {!verified && (
            <Alert role="note" variant="warning">
              {requirement.required
                ? "Two-step verification is required now. Set up an authenticator app to continue."
                : "Set up an authenticator app before the date above. You can keep using the workspace until then."}
            </Alert>
          )}
        </div>
      )}
      {flow.error && (
        <Alert role="alert" variant="destructive">
          {flow.error}
          {flow.status === null && (
            <Button
              className="mt-3 min-h-11"
              variant="outline"
              disabled={flow.pending}
              onClick={() => void flow.refresh()}
            >
              Retry
            </Button>
          )}
        </Alert>
      )}
      {flow.status === null ? (
        <p role="status">
          {flow.pending
            ? "Loading two-step verification…"
            : "Two-step verification settings are unavailable."}
        </p>
      ) : ready ? (
        <>
          <h3 className="font-semibold">Authenticator verified</h3>
          <p className="text-muted-foreground text-sm">
            Your authenticator protects this account. If you lose it, contact
            your administrator for recovery.
          </p>
          {!gate &&
            (confirmRemoval ? (
              <div className="flex flex-col gap-3">
                <p>Removing this authenticator signs you out on all devices.</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setConfirmRemoval(false)}
                    disabled={flow.pending}
                  >
                    Keep authenticator
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => void flow.removeVerified(verified.id)}
                    disabled={flow.pending}
                  >
                    Confirm removal
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmRemoval(true)}
              >
                Remove authenticator
              </Button>
            ))}
          {!gate && (
            <Button className="min-h-11" onClick={flow.cancel}>
              Done
            </Button>
          )}
        </>
      ) : factorId ? (
        <>
          <h3 className="font-semibold">Verify your authenticator</h3>
          {flow.credentials && (
            <div
              data-mfa-credential
              className="flex flex-col items-center gap-3"
            >
              <p className="text-muted-foreground text-sm">
                Scan this code with your authenticator app, or enter the setup
                key.
              </p>
              {/* SVG stays an image document; it cannot execute in the page. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="size-48 max-w-full rounded-md bg-white p-2"
                alt="Authenticator QR code"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(flow.credentials.totp.qr_code)}`}
              />
              <Field>
                <FieldLabel>Setup key</FieldLabel>
                <code className="rounded-md border px-3 py-2 text-sm break-all">
                  {flow.credentials.totp.secret}
                </code>
              </Field>
            </div>
          )}
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (/^\d{6}$/.test(code) && !flow.pending) {
                void flow.verify(factorId, code);
                setCode("");
              }
            }}
          >
            <Field data-mfa-credential>
              <FieldLabel htmlFor={gate ? "gate-mfa-code" : "manage-mfa-code"}>
                Verification code
              </FieldLabel>
              <Input
                id={gate ? "gate-mfa-code" : "manage-mfa-code"}
                value={code}
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                onChange={(event) =>
                  setCode(event.currentTarget.value.replace(/\D/g, ""))
                }
                disabled={flow.pending}
              />
            </Field>
            <Button
              className="min-h-11"
              type="submit"
              disabled={flow.pending || !/^\d{6}$/.test(code)}
            >
              Verify code
            </Button>
          </form>
        </>
      ) : (
        <>
          <h3 className="font-semibold">Authenticator app</h3>
          <p className="text-muted-foreground text-sm">
            Use an authenticator app to generate a code when you sign in. If you
            lose access, your administrator can help you recover your account.
          </p>
          <Button
            className="min-h-11"
            disabled={flow.pending}
            onClick={() => void flow.enroll()}
          >
            Set up authenticator
          </Button>
        </>
      )}
      {flow.pending && flow.status !== null && (
        <p role="status">Completing your request…</p>
      )}
      {!ready && !gate && (
        <Button
          className="min-h-11"
          variant="outline"
          onClick={() => {
            setCode("");
            flow.cancel();
          }}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
