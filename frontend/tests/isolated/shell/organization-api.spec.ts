import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "@playwright/test";
import { ZodError } from "zod";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  getManageWorkspace,
  getWorkspaceAppearance,
  updateManageWorkspace,
} from "../../../src/components/systems/manage/adapters/workspace-api";
import {
  manageKeys,
  newestManageWorkspace,
} from "../../../src/components/systems/manage/adapters/manage-queries";
import { installFetch } from "../platform/fixtures";

// The organization profile read accepts a full profile (contact keys present,
// possibly null) or a guest profile (no contact key at all) and nothing in
// between; a save reply must be a full profile; the public appearance read
// accepts only a known look and never starts an auth refresh; an older
// profile never replaces a newer accepted one. The patch rules are owned by
// isolated/manage/workspace-rules.spec.ts. The http journeys keep one example
// of each class with its exact wire body: "Organization malformed contact
// guest shape for admin ...", "Help contact ${fault} hides cached data ..."
// (403, 503, malformed) and "Organization public ${fault} keeps the valid
// cached look without auth refresh" (unavailable, unauthorized, malformed).

const common = {
  id: "33333333-3333-4333-8333-333333333333",
  display_name: "Profile organization",
  legal_name: "Harbor Services Ltd",
  description: "Plain organization description",
  logo_file_id: null,
  timezone: "Asia/Manila",
  locale: "en-PH",
  mark: "HS",
  currency: "PHP",
  week_start: "monday" as const,
  business_hours: "09:00–18:00",
  theme: "slate" as const,
  revision: 4,
};
const contacts = {
  contact_email: "contact@example.com",
  contact_phone: "+63 555 0100",
  postal_address: "Profile Street\nTest City",
};
const full = { ...common, ...contacts };

const accepted: { name: string; body: unknown; contacts: boolean }[] = [
  { name: "a full profile", body: full, contacts: true },
  {
    name: "a full profile with every contact null",
    body: {
      ...common,
      contact_email: null,
      contact_phone: null,
      postal_address: null,
    },
    contacts: true,
  },
  {
    name: "a guest profile without contact keys",
    body: common,
    contacts: false,
  },
  {
    name: "a full profile with an unrelated extra key",
    body: { ...full, unrelated_metadata: { accepted: true } },
    contacts: true,
  },
];

for (const row of accepted)
  test(`the organization read accepts ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      const profile = await getManageWorkspace();
      expect(profile.display_name).toBe("Profile organization");
      expect("contact_email" in profile).toBe(row.contacts);
      expect("unrelated_metadata" in profile).toBe(false);
      expect(String(mock.requests[0]?.input)).toBe("/api/workspace");
      expect(mock.requests[0]?.init?.cache).toBe("no-store");
    } finally {
      mock.restore();
    }
  });

const withoutPhone: Record<string, unknown> = { ...full };
delete withoutPhone.contact_phone;
const refused: { name: string; body: unknown }[] = [
  {
    name: "a guest profile with one contact key",
    body: { ...common, contact_email: "partial@example.com" },
  },
  { name: "a full profile without its phone", body: withoutPhone },
  {
    name: "a numeric contact phone",
    body: {
      ...common,
      contact_email: "valid@example.com",
      contact_phone: 42,
      postal_address: null,
    },
  },
  {
    name: "an object contact email",
    body: { ...full, contact_email: { secret: "Private failure canary" } },
  },
];

for (const row of refused)
  test(`the organization read refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(getManageWorkspace()).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("an organization save sends its patch and returns the full profile", async () => {
  const mock = installFetch(() =>
    Response.json({ ...full, legal_name: "New legal name", revision: 5 }),
  );
  try {
    const saved = await updateManageWorkspace({
      revision: 4,
      legal_name: "New legal name",
    });
    expect(saved).toMatchObject({ revision: 5, legal_name: "New legal name" });
    expect(mock.requests[0]?.init?.method).toBe("PATCH");
    expect(mock.requests[0]?.init?.body).toBe(
      '{"revision":4,"legal_name":"New legal name"}',
    );
  } finally {
    mock.restore();
  }
});

test("an organization save refuses a guest-shaped reply", async () => {
  const mock = installFetch(() => Response.json({ ...common, revision: 5 }));
  try {
    await expect(
      updateManageWorkspace({ revision: 4, legal_name: "New legal name" }),
    ).rejects.toBeInstanceOf(ApiContractError);
  } finally {
    mock.restore();
  }
});

test("an organization patch with an invalid currency is refused before a request", async () => {
  const mock = installFetch(() => Response.json(full));
  try {
    expect(() =>
      updateManageWorkspace({ revision: 4, currency: "usd" }),
    ).toThrow(ZodError);
    expect(mock.requests).toEqual([]);
  } finally {
    mock.restore();
  }
});

function clientWith(
  workspaceRevision: number | null,
  brandRevision: number | null,
) {
  const client = new QueryClient();
  if (workspaceRevision !== null)
    client.setQueryData(manageKeys.workspace(), {
      ...full,
      display_name: "Cached organization",
      revision: workspaceRevision,
    });
  if (brandRevision !== null)
    client.setQueryData(manageKeys.brand(), { revision: brandRevision });
  return client;
}

const revisions: {
  name: string;
  workspace: number | null;
  brand: number | null;
  incoming: number;
  result: "incoming" | "cached" | "refused";
}[] = [
  {
    name: "a first read",
    workspace: null,
    brand: null,
    incoming: 4,
    result: "incoming",
  },
  {
    name: "a read at the accepted revision",
    workspace: 4,
    brand: 4,
    incoming: 4,
    result: "incoming",
  },
  {
    name: "a newer read",
    workspace: 4,
    brand: 3,
    incoming: 5,
    result: "incoming",
  },
  {
    name: "an older read while the cached profile is current",
    workspace: 5,
    brand: 5,
    incoming: 4,
    result: "cached",
  },
  {
    name: "an older read while only the brand is current",
    workspace: 4,
    brand: 6,
    incoming: 5,
    result: "refused",
  },
];

const outcomes = {
  incoming: "keeps the incoming profile",
  cached: "keeps the cached profile",
  refused: "is refused",
} as const;

for (const row of revisions)
  test(`the organization cache: ${row.name} ${outcomes[row.result]}`, () => {
    const client = clientWith(row.workspace, row.brand);
    const incoming = {
      ...full,
      display_name: "Incoming organization",
      revision: row.incoming,
    };
    if (row.result === "refused") {
      expect(() => newestManageWorkspace(client, incoming)).toThrow(
        ApiContractError,
      );
      return;
    }
    expect(newestManageWorkspace(client, incoming).display_name).toBe(
      row.result === "incoming"
        ? "Incoming organization"
        : "Cached organization",
    );
  });

test("the public appearance read accepts a known look without a cache", async () => {
  const mock = installFetch(() => Response.json({ theme: "stockroom" }));
  try {
    expect(await getWorkspaceAppearance()).toEqual({ theme: "stockroom" });
    expect(String(mock.requests[0]?.input)).toBe("/api/workspace/appearance");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

const appearanceFaults: {
  name: string;
  status: number;
  body: unknown;
  error: typeof ApiError | typeof ApiContractError;
}[] = [
  {
    name: "an unavailable reply",
    status: 503,
    body: { detail: "Unavailable" },
    error: ApiError,
  },
  {
    name: "an unauthorized reply",
    status: 401,
    body: { detail: "Unavailable" },
    error: ApiError,
  },
  {
    name: "an unknown look",
    status: 200,
    body: { theme: "sepia" },
    error: ApiContractError,
  },
  {
    name: "a private extra key",
    status: 200,
    body: { theme: "whiteboard", contact_email: "private@example.test" },
    error: ApiContractError,
  },
];

for (const row of appearanceFaults)
  test(`the public appearance read refuses ${row.name} without an auth refresh`, async () => {
    const mock = installFetch(() =>
      Response.json(row.body, { status: row.status }),
    );
    try {
      await expect(getWorkspaceAppearance()).rejects.toBeInstanceOf(row.error);
      expect(mock.requests.map((request) => String(request.input))).toEqual([
        "/api/workspace/appearance",
      ]);
    } finally {
      mock.restore();
    }
  });
