import { expect, test } from "@playwright/test";

import type { SecuritySettingsFormFields } from "../../../src/components/systems/access/adapters/security-api";
import {
  advancedPolicySetCount,
  endAllSessionsSentence,
  policySummaryParts,
  sessionDetail,
  sessionDeviceWords,
} from "../../../src/components/systems/access/helpers/security-policy";

// The Security page's derived words (docs/specs/access-ui-ux-pass.md,
// Phase 5): the Advanced set count, the policy summary line and the End all
// confirmation. The http journeys in access-security-policy.spec.ts keep one
// example of each; these tables own the inputs.

// The installation defaults (backend platform settings), as the form shows them.
const defaults: SecuritySettingsFormFields = {
  minimumLength: "12",
  requireMixedCase: true,
  requireNumber: false,
  timeout: "60 minutes",
  absoluteLifetime: "Off",
  concurrentLimit: "Off",
  sessionRetention: "365",
  eventRetention: "365",
  requireMfaAdmin: false,
  requireMfaMember: false,
  requireMfaGuest: false,
  mfaGrace: "0",
  loginThreshold: "5",
  loginWindow: "15",
  loginCooldown: "15",
  ips: [],
  ipEntry: "",
};

const countRows: {
  name: string;
  change: Partial<SecuritySettingsFormFields>;
  count: number;
}[] = [
  { name: "the defaults", change: {}, count: 0 },
  {
    // The common settings never count: they are outside Advanced.
    name: "only common settings changed",
    change: {
      timeout: "8 hours",
      requireMfaAdmin: true,
      mfaGrace: "7",
    },
    count: 0,
  },
  {
    name: "a custom password rule set",
    change: {
      minimumLength: "13",
      requireMixedCase: false,
      requireNumber: true,
    },
    count: 3,
  },
  {
    // An address list counts once, whatever its length.
    name: "two allowed addresses",
    change: { ips: ["192.0.2.0/24", "198.51.100.7"] },
    count: 1,
  },
  {
    name: "every rare setting",
    change: {
      ips: ["192.0.2.0/24"],
      minimumLength: "20",
      requireMixedCase: false,
      requireNumber: true,
      absoluteLifetime: "720",
      concurrentLimit: "3",
      sessionRetention: "90",
      eventRetention: "730",
      loginThreshold: "3",
      loginWindow: "30",
      loginCooldown: "60",
    },
    count: 11,
  },
  {
    // A half-typed limit ("Limited" chosen, no number yet) is already set.
    name: "a limit chosen with no number yet",
    change: { absoluteLifetime: "" },
    count: 1,
  },
];

for (const row of countRows)
  test(`Advanced policy set count: ${row.name}`, () => {
    expect(advancedPolicySetCount({ ...defaults, ...row.change })).toBe(
      row.count,
    );
  });

const summaryRows: {
  name: string;
  change: Partial<SecuritySettingsFormFields>;
  parts: string[];
}[] = [
  {
    name: "the defaults",
    change: {},
    parts: ["12-character passwords", "Two-step optional", "60-minute timeout"],
  },
  {
    name: "two-step required for some roles and an 8-hour timeout",
    change: {
      minimumLength: "16",
      requireMfaAdmin: true,
      requireMfaGuest: true,
      timeout: "8 hours",
    },
    parts: [
      "16-character passwords",
      "Two-step for administrators, guests",
      "8-hour timeout",
    ],
  },
  {
    name: "session limits",
    change: {
      requireMfaAdmin: true,
      requireMfaMember: true,
      requireMfaGuest: true,
      timeout: "15 minutes",
      absoluteLifetime: "720",
      concurrentLimit: "3",
    },
    parts: [
      "12-character passwords",
      "Two-step for everyone",
      "15-minute timeout",
      "720-minute lifetime",
      "Up to 3 sessions",
    ],
  },
];

for (const row of summaryRows)
  test(`policy summary: ${row.name}`, () => {
    expect(policySummaryParts({ ...defaults, ...row.change })).toEqual(
      row.parts,
    );
  });

const sentenceRows: {
  name: string;
  count: { sessions: number; people: number; more: boolean } | null;
  sentence: string;
}[] = [
  {
    name: "many sessions on many people",
    count: { sessions: 14, people: 9, more: false },
    sentence: "Signs out 14 sessions on 9 people. Your current session stays.",
  },
  {
    name: "one session",
    count: { sessions: 1, people: 1, more: false },
    sentence: "Signs out 1 session on 1 person. Your current session stays.",
  },
  {
    // Only the first 100 sessions are read, so the people are a lower bound.
    name: "more sessions than one read holds",
    count: { sessions: 240, people: 61, more: true },
    sentence:
      "Signs out 240 sessions on at least 61 people. Your current session stays.",
  },
  {
    name: "a count that could not be read",
    count: null,
    sentence: "Signs out every other session. Your current session stays.",
  },
];

for (const row of sentenceRows)
  test(`End all remote sessions sentence: ${row.name}`, () => {
    expect(endAllSessionsSentence(row.count)).toBe(row.sentence);
  });

const deviceRows: {
  name: string;
  session: { device: string; browser: string; ip_address: string | null };
  words: string;
  detail: string;
}[] = [
  {
    name: "a known device with an address",
    session: {
      device: "Mobile",
      browser: "Chrome",
      ip_address: "198.51.100.7",
    },
    words: "Mobile Chrome",
    detail: "Mobile · Chrome · Sign-in address: 198.51.100.7",
  },
  {
    // Unknown parts drop out instead of repeating "Unknown".
    name: "a known device with no address",
    session: { device: "Desktop", browser: "Safari", ip_address: null },
    words: "Desktop Safari",
    detail: "Desktop · Safari",
  },
  {
    name: "an unknown device type with a known browser",
    session: { device: "Unknown", browser: "Firefox", ip_address: null },
    words: "Firefox",
    detail: "Firefox",
  },
  {
    name: "nothing known but the address",
    session: {
      device: "Unknown",
      browser: "Unknown",
      ip_address: "2001:db8::2",
    },
    words: "unknown device",
    detail: "Unknown device · Sign-in address: 2001:db8::2",
  },
  {
    name: "nothing known",
    session: { device: "Unknown", browser: "Unknown", ip_address: null },
    words: "unknown device",
    detail: "Unknown device",
  },
];

for (const row of deviceRows)
  test(`session device words: ${row.name}`, () => {
    expect(sessionDeviceWords(row.session)).toBe(row.words);
    expect(sessionDetail(row.session)).toBe(row.detail);
  });
