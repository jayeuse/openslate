import { expect, test } from "@playwright/test";

import {
  inactiveDaysError,
  parseInactiveDays,
} from "../../../src/components/systems/access/helpers/people";

// The Overview "Known inactive people" card applies an inactivity period only
// when the draft is a whole number of days from 1 to 3650. The http journey
// "inactivity days validate drafts, reach the API and isolate cached
// summaries by applied N" keeps one draft of each error message.

const range = "Enter a whole number from 1 to 3650.";

for (const row of [
  { draft: "30", days: 30, error: null },
  { draft: "1", days: 1, error: null },
  { draft: "3650", days: 3650, error: null },
  { draft: " 60 ", days: 60, error: null },
  { draft: "", days: null, error: "Enter the number of days." },
  { draft: "   ", days: null, error: "Enter the number of days." },
  { draft: "0", days: null, error: range },
  { draft: "3651", days: null, error: range },
  { draft: "1.5", days: null, error: range },
  { draft: "-1", days: null, error: range },
  { draft: "1e2", days: null, error: range },
]) {
  test(`inactivity days draft ${JSON.stringify(row.draft)}`, () => {
    expect(parseInactiveDays(row.draft)).toBe(row.days);
    expect(inactiveDaysError(row.draft)).toBe(row.error);
  });
}
