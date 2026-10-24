import { failureLabel, type ManageVersion } from "../adapters/backup-api";

// The words of the Updates & licensing summary (MD10): label-left rows for
// the version, the release check, the last observed release, the license and
// the limits. The license and limits are facts of every installation.

const EMPTY = "—";

export const LICENSE_WORDS = "No license required · Self-hosted";
export const LIMITS_WORDS = "None · capacity depends on your server";

const resultWords: Record<ManageVersion["status"], string> = {
  current: "Up to date",
  stale: "Release information is stale",
  unavailable: "Release information unavailable",
  unknown: "Version comparison unavailable",
  available: "",
};

export type ReleaseCheckWords = {
  /** The result word on its own (for example "Up to date"). */
  result: string;
  /** The recorded failure, when the last attempt failed. */
  failure: string | null;
  /** The last successful check and the last attempt, each "—" when missing. */
  times: string;
};

export function versionWords(version: ManageVersion): string {
  return `${version.current_version} · Stable channel`;
}

export function releaseCheckWords(
  version: ManageVersion,
  formatTime: (value: string) => string,
): ReleaseCheckWords {
  const at = (value: string | null) => (value ? formatTime(value) : EMPTY);
  return {
    result:
      version.status === "available"
        ? `Version ${version.latest_version ?? EMPTY} is available`
        : version.status === "unknown" && !version.observed_at
          ? "Not checked yet"
          : resultWords[version.status],
    failure: version.failure_code ? failureLabel(version.failure_code) : null,
    times: `Last successful check ${at(version.observed_at)} · Last attempt ${at(version.checked_at)}`,
  };
}

/**
 * The last observed release, when one is known and says something new: not
 * already named as available, and not the running version.
 */
export function latestReleaseWords(version: ManageVersion): string | null {
  return version.latest_version &&
    version.status !== "available" &&
    version.latest_version !== version.current_version
    ? version.latest_version
    : null;
}
