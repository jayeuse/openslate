import { expect, test } from "@playwright/test";

import { platformSectionFromSearch } from "../../../src/components/systems/platform/helpers/platform-section";

// Platform opens the section its `section` query names, or Search for any
// other value; without a query, the #account and #notifications hashes open
// their sections. A query always wins over the hash. The http journeys keep
// the Account redirect to Profile ("Profile legacy entry ${entry} replaces to
// the correct section") and the query precedence ("Profile entry honors
// explicit Platform section precedence and Your profile navigation").

for (const row of [
  { section: "search", hash: "", opens: "Search" },
  { section: "files", hash: "", opens: "Files" },
  { section: "notifications", hash: "", opens: "Notifications" },
  { section: "import-export", hash: "", opens: "Import & export" },
  { section: "account", hash: "", opens: "Account" },
  { section: "records", hash: "", opens: "Search" },
  { section: "", hash: "", opens: "Search" },
  { section: "", hash: "#account", opens: "Search" },
  { section: "Files", hash: "", opens: "Search" },
  { section: "__proto__", hash: "", opens: "Search" },
  { section: "constructor", hash: "", opens: "Search" },
  { section: "search", hash: "#account", opens: "Search" },
  { section: "records", hash: "#notifications", opens: "Search" },
  { section: null, hash: "", opens: "Search" },
  { section: null, hash: "#account", opens: "Account" },
  { section: null, hash: "#notifications", opens: "Notifications" },
  { section: null, hash: "#files", opens: "Search" },
  { section: null, hash: "#Account", opens: "Search" },
] as const)
  test(`Platform section ${JSON.stringify(row.section)} with hash ${JSON.stringify(row.hash)} opens ${row.opens}`, () => {
    expect(platformSectionFromSearch(row.section, row.hash)).toBe(row.opens);
  });
