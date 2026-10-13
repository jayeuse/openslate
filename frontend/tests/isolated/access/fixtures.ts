import { wirePagination } from "../../helpers/pagination";

// Response bodies shaped like the current FastAPI Access models. Each one is
// the smallest valid example; tests spread and change single fields.

export const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  guest: "00000000-0000-4000-8000-000000000002",
  department: "00000000-0000-4000-8000-000000000003",
  module: "00000000-0000-4000-8000-000000000004",
  group: "00000000-0000-4000-8000-000000000005",
  session: "00000000-0000-4000-8000-000000000006",
  workspace: "00000000-0000-4000-8000-000000000007",
};
export const timestamp = "2026-09-28T00:00:00Z";

export const pagination = wirePagination({ limit: 25, count: 1, total: 1 });

export const user = {
  id: ids.guest,
  email: "ana@example.com",
  username: "ana",
  status: "active",
  role: "guest",
  display_name: "Ana Santos",
  job_title: "Auditor",
  sponsor_user_id: ids.admin,
  expires_at: "2026-10-28T00:00:00Z",
  invitation_sent_at: timestamp,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.admin,
};

/** Only GET /users list rows carry monitoring projections. */
export const directoryUser = {
  ...user,
  active_session_count: 0,
  mfa_verified_totp: null,
  mfa_observed_at: null,
  last_sign_in_at: null,
  last_active_at: null,
};

export const group = {
  id: ids.group,
  name: "Inventory clerks",
  description: "Keep stock records current.",
  revision: 3,
  member_ids: [ids.guest],
  access: [
    {
      department_id: ids.department,
      module_id: null,
      level: "read",
      department_name: "Inventory",
      module_name: null,
    },
    {
      department_id: ids.department,
      module_id: ids.module,
      level: "write",
      department_name: "Inventory",
      module_name: "Prices",
    },
  ],
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.admin,
};

export const memberCandidate = {
  id: ids.guest,
  display_name: "Ana Santos",
  username: "ana",
  email: "ana@example.com",
  role: "guest",
  status: "pending",
  access_ends_at: null,
};

export const session = {
  id: ids.session,
  created_at: timestamp,
  refreshed_at: timestamp,
  expires_at: "2026-10-28T00:00:00Z",
  user_agent: "Mozilla/5.0",
  current: false,
  ip_address: null,
};

export const department = {
  id: ids.department,
  department_name: "Inventory",
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.admin,
};

export const accessModule = {
  id: ids.module,
  department_id: ids.department,
  module_name: "Prices",
  title_field_id: null,
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  is_deleted: false,
  performed_by: ids.admin,
};

/** The whole workspace resource; Access reads only the invitation settings. */
export const workspace = {
  id: ids.workspace,
  display_name: "Northwind",
  legal_name: null,
  description: null,
  contact_email: null,
  contact_phone: null,
  postal_address: null,
  logo_file_id: null,
  timezone: "Asia/Manila",
  locale: "en-PH",
  invitation_expiry_days: 7,
  guest_duration_days: 30,
  revision: 4,
  created_at: timestamp,
  updated_at: timestamp,
  today: "2026-09-28",
};

export function pageOf<Item>(items: Item[]) {
  return { items, pagination: { ...pagination, count: items.length } };
}

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

export function installFetch(
  response: (input: RequestInfo | URL, init?: RequestInit) => Response,
): { requests: RecordedRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return response(input, init);
  };
  return { requests, restore: () => (globalThis.fetch = originalFetch) };
}

/** Cookie-authenticated mutations read the CSRF token from document.cookie. */
export function installCsrfCookie(token: string): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: `openslate_csrf=${token}` },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  };
}
