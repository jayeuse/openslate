import type { Page, Route } from "@playwright/test";
import { pageOf } from "../../helpers/pagination";
import { appearanceUrl, authMeBody, defaultOrganization } from "./test";

export const logoActor = "11111111-1111-4111-8111-111111111111";
export const oldLogoId = "22222222-2222-4222-8222-222222222222";
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMoCDgARAwQCgAozgYBqU59jgAAAABJRU5ErkJggg==",
  "base64",
);
export const logoWorkspace = {
  id: "33333333-3333-4333-8333-333333333333",
  display_name: "Harbor Services",
  legal_name: "Harbor Services Ltd" as string | null,
  description: "Saved organization description" as string | null,
  contact_email: "contact@example.test" as string | null,
  contact_phone: "+63 555 0100" as string | null,
  postal_address: "Test address" as string | null,
  logo_file_id: null as string | null,
  locale: "en-PH",
  timezone: "Asia/Manila",
  mark: "HS",
  currency: "PHP",
  week_start: "monday",
  business_hours: "09:00–18:00",
  theme: "slate",
  revision: 4,
  today: "2026-10-06",
  purge_enabled: false,
};

export function logoFile(
  id: string,
  state:
    "awaiting_upload" | "uploading" | "ready" | "deleting" | "purged" = "ready",
) {
  return {
    id,
    purpose: "workspace_logo",
    record_id: null,
    board_id: null,
    department_id: null,
    creator_id: logoActor,
    filename: `${id}.png`,
    media_type: state === "awaiting_upload" ? null : "image/png",
    expected_size: png.length,
    actual_size: state === "awaiting_upload" ? null : png.length,
    state,
    failure_code: state === "deleting" ? "deletion_unresolved" : null,
    is_deleted: state === "deleting" || state === "purged",
    created_at: "2026-10-06T01:00:00Z",
    updated_at: "2026-10-06T01:00:00Z",
  };
}
type LogoFile = ReturnType<typeof logoFile>;

/** Owned public-API fixtures; lifecycle origin never crosses the wire. */
export async function installLogoApi(page: Page) {
  const api = {
    actor: logoActor,
    role: "admin" as "admin" | "member" | "guest",
    workspace: { ...logoWorkspace },
    files: new Map<string, LogoFile>(),
    writes: [] as { path: string; body: Record<string, unknown> | null }[],
    lists: [] as URLSearchParams[],
    logoReads: 0,
    sessionReads: 0,
    workspaceReads: 0,
    readStatus: 200,
    failure: null as "partial" | "lost" | "before" | "stale" | null,
    uploadUnresolved: false,
    reconcileDenied: false,
    reconcileMessage: "Permanent purge is disabled",
    inlineInvalid: false,
    onLogo: null as ((route: Route) => Promise<void>) | null,
    onUpload: null as ((route: Route) => Promise<void>) | null,
    onFileRead: null as ((route: Route) => Promise<void>) | null,
    onSession: null as ((route: Route) => Promise<void>) | null,
    onPatch: null as
      ((route: Route, receipt: typeof logoWorkspace) => Promise<void>) | null,
  };
  await page.route("**/api/auth/session", (route) => {
    api.sessionReads += 1;
    return api.onSession
      ? api.onSession(route)
      : route.fulfill({
          json: {
            authenticated: true,
            user_id: api.actor,
            organization_id: defaultOrganization.org_id,
            default_organization_blocked: null,
            setup_required: false,
          },
        });
  });
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: authMeBody({
        id: api.actor,
        role: api.role,
        access: [],
        default_organization_blocked: null,
      }),
    }),
  );
  await page.route(appearanceUrl, (route) =>
    route.fulfill({
      json: { theme: api.workspace.theme },
    }),
  );
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() === "GET") {
      api.workspaceReads += 1;
      if (api.readStatus !== 200)
        return route.fulfill({
          status: api.readStatus,
          json: { detail: "Current settings unavailable" },
        });
      const body: Record<string, unknown> = { ...api.workspace };
      if (api.role === "guest") {
        delete body.contact_email;
        delete body.contact_phone;
        delete body.postal_address;
      }
      await route.fulfill({ json: body });
      return;
    }
    const patch: Record<string, unknown> = route.request().postDataJSON();
    api.writes.push({ path: "/workspace", body: patch });
    if (api.role !== "admin") {
      await route.fulfill({ status: 403, json: { detail: "Forbidden" } });
      return;
    }
    if (api.failure === "stale" || patch.revision !== api.workspace.revision) {
      api.failure = null;
      api.workspace.revision += 1;
      await route.fulfill({
        status: 409,
        json: { detail: { code: "stale_revision" } },
      });
      return;
    }
    if (api.failure === "before") {
      api.failure = null;
      await route.abort("failed");
      return;
    }
    const old = api.workspace.logo_file_id;
    const changed = "logo_file_id" in patch && patch.logo_file_id !== old;
    if (changed && patch.logo_file_id !== null) {
      if (
        typeof patch.logo_file_id !== "string" ||
        api.files.get(patch.logo_file_id)?.state !== "ready"
      ) {
        await route.fulfill({
          status: 409,
          json: { detail: { code: "logo_not_ready" } },
        });
        return;
      }
    }
    Object.assign(api.workspace, patch, {
      revision: api.workspace.revision + 1,
    });
    if (changed && old) {
      const file = api.files.get(old);
      if (!file) throw new Error("Owned old logo is missing");
      Object.assign(
        file,
        logoFile(old, api.failure === "partial" ? "deleting" : "purged"),
      );
    }
    const receipt = { ...api.workspace };
    if (api.onPatch) return api.onPatch(route, receipt);
    if (api.failure === "partial") {
      api.failure = null;
      await route.fulfill({
        status: 503,
        json: {
          detail: {
            code: "workspace_logo_cleanup_partial",
            message: "Settings saved; old logo cleanup needs retry.",
          },
        },
      });
    } else if (api.failure === "lost") {
      api.failure = null;
      await route.abort("failed");
    } else await route.fulfill({ json: api.workspace });
  });
  await page.route("**/api/workspace/logo", async (route) => {
    api.logoReads += 1;
    if (api.onLogo) return api.onLogo(route);
    if (!api.workspace.logo_file_id) return route.fulfill({ status: 404 });
    return route.fulfill({
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
      contentType: api.inlineInvalid ? "image/svg+xml" : "image/png",
      body: api.inlineInvalid ? "<svg/>" : png,
    });
  });
  await page.route(/\/api\/files(?:\?|\/|$)/, async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(
      /^\/api\/files\/([^/]+)(?:\/(content|reconcile))?$/,
    );
    const method = route.request().method();
    if (!match && method === "POST") {
      const body: Record<string, unknown> = route.request().postDataJSON();
      api.writes.push({ path: "/files", body });
      if (
        body.purpose !== "workspace_logo" ||
        typeof body.filename !== "string" ||
        typeof body.expected_size !== "number"
      )
        throw new Error(
          "Expected logo reservation through the existing File API",
        );
      const id = `44444444-4444-4444-8444-${String(api.files.size + 1).padStart(12, "0")}`;
      const file = {
        ...logoFile(id, "awaiting_upload"),
        filename: body.filename,
        expected_size: body.expected_size,
      };
      api.files.set(id, file);
      await route.fulfill({ status: 201, json: file });
      return;
    }
    if (!match) {
      api.lists.push(url.searchParams);
      if (api.role !== "admin") return route.fulfill({ status: 403 });
      const all = [...api.files.values()];
      const limit = Number(url.searchParams.get("limit") ?? "4");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const items = all.slice(offset, offset + limit);
      return route.fulfill({
        json: pageOf(items, { limit, offset, total: all.length }),
      });
    }
    const [, id, action] = match;
    const file = api.files.get(id);
    if (!file) return route.fulfill({ status: 404 });
    if (!action && method === "GET" && api.onFileRead)
      return api.onFileRead(route);
    if (action === "content" && method === "PUT") {
      api.writes.push({ path: `/files/${id}/content`, body: null });
      if (api.onUpload) return api.onUpload(route);
      Object.assign(file, {
        ...logoFile(id, api.uploadUnresolved ? "uploading" : "ready"),
        filename: file.filename,
        expected_size: file.expected_size,
      });
      return route.fulfill({
        status: api.uploadUnresolved ? 503 : 200,
        json: api.uploadUnresolved
          ? { detail: { code: "upload_unresolved" } }
          : file,
      });
    }
    if (action === "reconcile" && method === "POST") {
      api.writes.push({ path: `/files/${id}/reconcile`, body: null });
      if (api.role !== "admin" || api.reconcileDenied)
        return route.fulfill({
          status: 403,
          json: {
            detail: {
              code: "purge_disabled",
              message: api.reconcileMessage,
            },
          },
        });
      Object.assign(file, {
        ...logoFile(id, file.state === "uploading" ? "ready" : "purged"),
        filename: file.filename,
        expected_size: file.expected_size,
      });
    }
    await route.fulfill({ json: file });
  });
  return api;
}
