import { expect, test } from "@playwright/test";

import type { ManageVersion } from "../../../src/components/systems/manage/adapters/backup-api";
import { staticMarkup } from "../sandbox/static-markup";
import {
  UpdatesPanelHarness,
  type UpdatesPanelState,
} from "./updates-panel-harness";

// What the Software version panel says for each recorded version state. The
// http journeys keep the refresh, the event-driven re-read, the load failure
// and the administrator-only denial: "Updates and licensing share a real
// read-only destination and never simulate upgrades or licenses" and
// "Recorded version loading, denial, stale and current observations remain
// honest on refresh". The current, unknown and not-recorded states moved
// here with the same version records.

function panel(state: UpdatesPanelState): string {
  return staticMarkup(UpdatesPanelHarness, { state });
}

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

const notEstablished =
  "The last observation does not establish whether this installation is current.";

for (const row of [
  {
    name: "an unavailable release source says so and claims nothing",
    state: { version: version({}) },
    shown: [
      ">0.1.0<",
      "Release information unavailable",
      notEstablished,
      "<dd>Not recorded</dd>",
      "<dd>Oct 7, 2026, 11:00 PM</dd>",
      '<div role="status" data-slot="alert" data-variant="default"',
      "The release source was unavailable",
    ],
    hidden: ["Up to date", "Release notes", "Last observed release"],
  },
  {
    name: "an available release names it and links its notes",
    state: {
      version: version({
        status: "available",
        latest_version: "0.2.0",
        observed_at: "2026-10-08T04:00:00Z",
        checked_at: "2026-10-08T04:00:00Z",
        failure_code: null,
        release_url: "https://github.com/jayeuse/openslate/releases/tag/v0.2.0",
      }),
    },
    shown: [
      "Version 0.2.0 is available",
      '<div role="status" data-slot="alert" data-variant="warning"',
      'href="https://github.com/jayeuse/openslate/releases/tag/v0.2.0"',
      ">Release notes<",
    ],
    hidden: ["Up to date", notEstablished, "Last observed release"],
  },
  {
    name: "a stale observation is not called current",
    state: {
      version: version({
        status: "stale",
        latest_version: "0.2.0",
        observed_at: "2026-10-01T00:00:00Z",
      }),
    },
    shown: [
      "Release information is stale",
      notEstablished,
      "<dt>Last observed release</dt><dd>0.2.0</dd>",
    ],
    hidden: ["Up to date"],
  },
  {
    name: "a current version shows Up to date and its release check",
    state: {
      version: version({
        status: "current",
        latest_version: "0.1.0",
        observed_at: "2026-10-08T04:00:00Z",
        failure_code: null,
      }),
    },
    shown: [
      ">Up to date<",
      "Release check",
      "<dt>Last observed release</dt><dd>0.1.0</dd>",
    ],
    hidden: ['role="status"', notEstablished, "<dt>Failure</dt>"],
  },
  {
    name: "an unknown comparison with an observation shows the observed release",
    state: {
      version: version({
        current_version: "2.7.1-development",
        status: "unknown",
        latest_version: "2.7.1",
        observed_at: "2026-10-08T04:00:00Z",
        checked_at: "2026-10-08T04:01:00Z",
        failure_code: null,
        release_url: "https://github.com/jayeuse/openslate/releases/tag/v2.7.1",
      }),
    },
    shown: [
      ">2.7.1-development<",
      "Version comparison unavailable",
      "<dt>Last observed release</dt><dd>2.7.1</dd>",
      'href="https://github.com/jayeuse/openslate/releases/tag/v2.7.1"',
    ],
    hidden: ["No release observation recorded", "Up to date"],
  },
  {
    name: "an unknown comparison without an observation says none is recorded",
    state: {
      version: version({
        current_version: "2.7.1-development",
        status: "unknown",
        latest_version: null,
        observed_at: null,
        checked_at: null,
        failure_code: null,
        release_url: null,
      }),
    },
    shown: [">2.7.1-development<", "No release observation recorded"],
    hidden: [
      "Version comparison unavailable",
      "Release notes",
      "Up to date",
      "Last observed release",
    ],
  },
  {
    name: "a refused read shows the administrator-only message and no version",
    state: { version: null, refused: true },
    shown: ["Only administrators can review version status."],
    hidden: ["Current version", "Release check", "Loading version status"],
  },
  {
    name: "a failed read asks to try again and shows no version",
    state: { version: null, failed: true },
    shown: ["Version status could not be loaded. Try again."],
    hidden: ["Current version", "Release check"],
  },
  {
    name: "a first read in progress says it is loading",
    state: { version: null, pending: true },
    shown: ["Loading version status…"],
    hidden: ["Current version", 'role="alert"'],
  },
]) {
  test(`software version: ${row.name}`, () => {
    const html = panel(row.state);
    for (const text of row.shown) expect(html).toContain(text);
    for (const text of row.hidden) expect(html).not.toContain(text);
  });
}
