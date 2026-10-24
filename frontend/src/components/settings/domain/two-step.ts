import type { MfaStatus } from "@/lib/mfa-api";
import type { StatusTone } from "@/components/ui/status-word";

/** The Two-step row's status word (PD11); On only for a verified authenticator. */
export function twoStepWord(status: MfaStatus | null | undefined): {
  word: string;
  tone: StatusTone;
} {
  // No status means the read failed: a warning, with Retry beside it.
  if (!status) return { word: "Unavailable", tone: "warn" };
  const on = status.factors.some(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );
  if (on) return { word: "On", tone: "flow" };
  return status.policy_required
    ? { word: "Off, required", tone: "warn" }
    : { word: "Off", tone: "muted" };
}
