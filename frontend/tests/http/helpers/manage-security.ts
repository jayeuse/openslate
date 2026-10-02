import type { Page } from "./test";

export async function mockManageSecurity(page: Page) {
  const state = {
    policy: {
      revision: 1,
      session_timeout_minutes: 60,
      password_min_length: 12,
      password_require_mixed_case: true,
      password_require_number: false,
      mfa_policy: "optional",
      ip_allow_list: [] as string[],
    },
    workspace: {
      id: "00000000-0000-4000-8000-000000000090",
      display_name: "Harbor School",
      locale: "en-PH",
      timezone: "Asia/Manila",
      mark: "HS",
      currency: "PHP",
      week_start: "monday",
      business_hours: "09:00–18:00",
      revision: 1,
    },
    sessions: [
      ["Mara", "Desktop", "Chrome"],
      ["Eli", "Mobile", "Chrome"],
      ["Iris", "Desktop", "Safari"],
      ["Paolo", "Desktop", "Edge"],
      ["Lian", "Tablet", "Safari"],
      ["Tomas", "Mobile", "Chrome"],
      ["Rhea", "Unknown", "Unknown"],
    ].map(([person_name, device, browser], index) => ({
      id: `00000000-0000-4000-8000-${String(101 + index).padStart(12, "0")}`,
      user_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      person_name,
      user_agent: index === 6 ? null : `${browser} test agent`,
      device,
      browser,
      created_at: "2026-10-01T01:00:00Z",
      refreshed_at: `2026-10-02T0${7 - index}:00:00Z`,
      expires_at: "2026-10-03T07:00:00Z",
      current: index === 0,
    })),
    sessionReads: [] as URLSearchParams[],
    policyReads: 0,
    workspaceReads: 0,
    writes: [] as { path: string; body: unknown }[],
    policyReadStatus: 200,
    sessionReadStatus: 200,
    policyWriteFailure: null as { status: number; code: string } | null,
    sessionWriteStatus: 204,
  };
  await page.route("**/api/workspace", async (route) => {
    state.workspaceReads += 1;
    await route.fulfill({ json: state.workspace });
  });
  await page.route("**/api/workspace/security", async (route) => {
    if (route.request().method() === "GET") {
      state.policyReads += 1;
      await route.fulfill({
        status: state.policyReadStatus,
        json:
          state.policyReadStatus === 200
            ? state.policy
            : { detail: { code: "unavailable", message: "Unavailable" } },
      });
      return;
    }
    const patch: Record<string, unknown> = route.request().postDataJSON();
    state.writes.push({ path: "/workspace/security", body: patch });
    const failure = state.policyWriteFailure;
    if (failure || patch.revision !== state.policy.revision) {
      const code = failure?.code ?? "stale_revision";
      await route.fulfill({
        status: failure?.status ?? 409,
        json: { detail: { code, message: "Policy was not saved." } },
      });
      return;
    }
    Object.assign(state.policy, patch, { revision: state.policy.revision + 1 });
    if (Array.isArray(patch.ip_allow_list)) {
      state.policy.ip_allow_list = patch.ip_allow_list.map(
        (network: unknown) => {
          if (typeof network !== "string")
            throw new Error("Expected an IP range");
          return network.includes("/")
            ? network
            : `${network}/${network.includes(":") ? 128 : 32}`;
        },
      );
    }
    state.workspace.revision = state.policy.revision;
    await route.fulfill({ json: state.policy });
  });
  await page.route("**/api/auth/admin-sessions**", async (route) => {
    if (route.request().method() === "DELETE") {
      state.writes.push({ path: "/auth/admin-sessions", body: null });
      if (state.sessionWriteStatus === 204)
        state.sessions = state.sessions.filter((session) => session.current);
      await route.fulfill({ status: state.sessionWriteStatus });
      return;
    }
    const query = new URL(route.request().url()).searchParams;
    state.sessionReads.push(query);
    if (state.sessionReadStatus !== 200) {
      await route.fulfill({
        status: state.sessionReadStatus,
        json: { detail: "Sessions unavailable" },
      });
      return;
    }
    const search = (query.get("search") ?? "").trim().toLowerCase();
    const status = query.get("status") ?? "all";
    const device = query.get("device") ?? "all";
    const filtered = state.sessions.filter(
      (session) =>
        [session.person_name, session.device, session.browser]
          .join(" ")
          .toLowerCase()
          .includes(search) &&
        (status === "all" || (status === "current") === session.current) &&
        (device === "all" || device === session.device),
    );
    const direction = query.get("sort_order") === "asc" ? 1 : -1;
    filtered.sort(
      (left, right) =>
        direction *
        (query.get("sort_by") === "person_name"
          ? left.person_name.localeCompare(right.person_name)
          : left.refreshed_at.localeCompare(right.refreshed_at)),
    );
    const limit = Number(query.get("limit") ?? "4");
    const offset = Number(query.get("offset") ?? "0");
    const items = filtered.slice(offset, offset + limit);
    await route.fulfill({
      json: {
        items,
        pagination: {
          limit,
          offset,
          count: items.length,
          total: filtered.length,
          has_more: offset + items.length < filtered.length,
        },
      },
    });
  });
  await page.route("**/api/users/*/sessions/*", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    state.writes.push({ path, body: null });
    if (state.sessionWriteStatus === 204)
      state.sessions = state.sessions.filter(
        (session) => !path.endsWith(`/${session.id}`),
      );
    await route.fulfill({ status: state.sessionWriteStatus });
  });
  return state;
}
