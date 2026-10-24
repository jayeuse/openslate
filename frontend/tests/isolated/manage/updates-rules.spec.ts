import { expect, test } from "@playwright/test";

import type { ManageVersion } from "../../../src/components/systems/manage/adapters/backup-api";
import {
  latestReleaseWords,
  releaseCheckWords,
  versionWords,
} from "../../../src/components/systems/manage/domain/updates-rules";

// The words of the Updates & licensing summary (MD10). The rendered panel is
// owned by updates-panel.spec.ts, and the journeys by "Updates and licensing
// share a real read-only destination and never simulate upgrades or licenses".

function version(values: Partial<ManageVersion>): ManageVersion {
  return {
    current_version: "0.1.0",
    status: "unavailable",
    latest_version: null,
    observed_at: null,
    checked_at: "2026-10-08T03:00:00Z",
    failure_code: "release_unavailable",
    release_url: null,
    ...values,
  };
}
const at = (value: string) => `at ${value}`;

test("the Updates rows name the version, the release check result, its failure and both times", () => {
  for (const row of [
    {
      name: "an unavailable release source",
      version: version({}),
      check: {
        result: "Release information unavailable",
        failure: "The release source was unavailable",
        times: "Last successful check — · Last attempt at 2026-10-08T03:00:00Z",
      },
      latest: null,
    },
    {
      name: "an available release",
      version: version({
        status: "available",
        latest_version: "0.2.0",
        observed_at: "2026-10-08T04:00:00Z",
        checked_at: "2026-10-08T04:00:00Z",
        failure_code: null,
      }),
      check: {
        result: "Version 0.2.0 is available",
        failure: null,
        times:
          "Last successful check at 2026-10-08T04:00:00Z · Last attempt at 2026-10-08T04:00:00Z",
      },
      latest: null,
    },
    {
      name: "a stale observation",
      version: version({
        status: "stale",
        latest_version: "0.2.0",
        observed_at: "2026-10-01T00:00:00Z",
        failure_code: null,
      }),
      check: {
        result: "Release information is stale",
        failure: null,
        times:
          "Last successful check at 2026-10-01T00:00:00Z · Last attempt at 2026-10-08T03:00:00Z",
      },
      latest: "0.2.0",
    },
    {
      name: "a current version",
      version: version({
        status: "current",
        latest_version: "0.1.0",
        observed_at: "2026-10-08T04:00:00Z",
        failure_code: null,
      }),
      check: {
        result: "Up to date",
        failure: null,
        times:
          "Last successful check at 2026-10-08T04:00:00Z · Last attempt at 2026-10-08T03:00:00Z",
      },
      // The running version is the latest; no row repeats it.
      latest: null,
    },
    {
      name: "an unknown comparison with an observation",
      version: version({
        status: "unknown",
        latest_version: "2.7.1",
        observed_at: "2026-10-08T04:00:00Z",
        failure_code: null,
      }),
      check: {
        result: "Version comparison unavailable",
        failure: null,
        times:
          "Last successful check at 2026-10-08T04:00:00Z · Last attempt at 2026-10-08T03:00:00Z",
      },
      latest: "2.7.1",
    },
    {
      name: "a release that was never checked",
      version: version({
        status: "unknown",
        checked_at: null,
        failure_code: null,
      }),
      check: {
        result: "Not checked yet",
        failure: null,
        times: "Last successful check — · Last attempt —",
      },
      latest: null,
    },
  ]) {
    expect(releaseCheckWords(row.version, at), row.name).toEqual(row.check);
    expect(latestReleaseWords(row.version), row.name).toBe(row.latest);
  }
  expect(versionWords(version({ current_version: "0.1.0" }))).toBe(
    "0.1.0 · Stable channel",
  );
});
