import { expect, heldResponse, quietEventSource, type Page } from "./test";

declare global {
  interface Window {
    observeProfilePhotoRevocation: (url: string) => Promise<void>;
  }
}

export const profileUserA = "00000000-0000-4000-8000-000000000001";
export const profileUserB = "00000000-0000-4000-8000-000000000002";
export const avatarFileId = "00000000-0000-4000-8000-000000000701";
const stamp = "2026-10-01T00:30:00Z";
export const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=",
  "base64",
);

export const regionalDefaults = {
  timezone: null as string | null,
  date_format: "organization",
  time_format: "organization",
  week_start: "organization",
  start_page: "automatic",
};

export function profilePreferences(
  userId = profileUserA,
  appearance: Record<string, unknown> = {},
) {
  return {
    user_id: userId,
    theme: "light",
    appearance: {
      motion: "system",
      keyboard_shortcuts: true,
      ...regionalDefaults,
      ...appearance,
    },
  };
}

export function profileSelf(
  id = profileUserA,
  role: "admin" | "member" | "guest" | null = "member",
) {
  const flat = {
    id,
    email: id === profileUserB ? "second@example.test" : "person@example.test",
    username: id === profileUserB ? "second_person" : "owned_person",
    role,
    status: "active",
    display_name: id === profileUserB ? "Second person" : "Maya Chen",
    job_title: "Equipment coordinator" as string | null,
    phone: "+1 555 0101" as string | null,
    bio: "Coordinates shared equipment." as string | null,
    avatar_file_id: null as string | null,
    sponsor_user_id: role === "guest" ? profileUserB : null,
    expires_at: role === "guest" ? "2027-10-01T00:00:00Z" : null,
    invitation_sent_at: null,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
    access: [] as {
      department_id: string;
      module_id: string | null;
      level: "read" | "write" | "manage";
    }[],
  };
  const account = Object.fromEntries(
    Object.entries(flat).filter(
      ([key]) =>
        ![
          "role",
          "access",
          "sponsor_user_id",
          "expires_at",
          "invitation_sent_at",
        ].includes(key),
    ),
  );
  const org = {
    org_id: "00000000-0000-4000-8000-000000000901",
    name: "Example",
    slug: "example",
    role,
  };
  return {
    ...flat,
    operator: role === "admin",
    account,
    memberships: role ? [org] : [],
    pending_invitations: [],
    current_organization: role
      ? { ...org, access: flat.access, owner: role === "admin" }
      : null,
    default_organization_blocked: null,
  };
}

/**
 * `heldResponse` under the names the email-change helpers use: the handler
 * calls `start()` and awaits `waiting`; the test awaits `begun`.
 */
export function profileGate() {
  const held = heldResponse();
  return {
    waiting: held.released,
    begun: held.entered,
    release: held.release,
    start: held.enter,
  };
}

/** Observe the browser resource contract without suppressing native cleanup. */
export async function observeProfilePhotoRevocations(page: Page) {
  const revoked: string[] = [];
  await page.exposeFunction("observeProfilePhotoRevocation", (url: string) => {
    revoked.push(url);
  });
  await page.addInitScript(() => {
    const nativeRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      void window.observeProfilePhotoRevocation(url);
      nativeRevoke(url);
    };
  });
  return revoked;
}

/** Independent wire DTOs and stored state, not schemas imported from the adapter. */
export async function installProfileApi(
  page: Page,
  options: {
    role?: "admin" | "member" | "guest" | null;
    session?: boolean;
    mfa?: boolean;
  } = {},
) {
  const people = new Map([
    [profileUserA, profileSelf(profileUserA, options.role)],
    [profileUserB, profileSelf(profileUserB, options.role)],
  ]);
  const state = {
    people,
    userId: profileUserA,
    selfReads: [] as string[],
    writes: [] as {
      method: string;
      path: string;
      body: unknown;
      userId: string;
    }[],
    forbiddenReads: [] as string[],
    selfStatus: 200,
    patchStatus: 200,
    preferencesStatus: 200,
    preferencesWriteStatus: 200,
    uploadStatus: 200,
    uploadCompletions: 0,
    partialCleanup: false,
    selfShape: null as
      ((body: ReturnType<typeof profileSelf>) => unknown) | null,
    fileShape: null as ((body: Record<string, unknown>) => unknown) | null,
    avatarFault: null as "mime" | "oversize" | "headers" | null,
    holdSelf: null as ReturnType<typeof heldResponse> | null,
    holdPatch: null as ReturnType<typeof heldResponse> | null,
    holdUpload: null as ReturnType<typeof heldResponse> | null,
    holdPreferences: null as ReturnType<typeof heldResponse> | null,
    appearance: {
      motion: "system",
      keyboard_shortcuts: true,
      ...regionalDefaults,
    },
    theme: "light",
    files: new Map<string, Record<string, unknown>>(),
    avatarReads: [] as string[],
  };
  await quietEventSource(page);
  if (options.session !== false) {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          user_id: state.userId,
          organization_id:
            people.get(state.userId)!.current_organization?.org_id ?? null,
          default_organization_blocked: null,
          setup_required: false,
        },
      }),
    );
  }
  await page.route("**/api/auth/me", async (route) => {
    const actor = state.userId;
    const self = structuredClone(people.get(actor)!);
    state.selfReads.push(actor);
    const hold = state.holdSelf;
    state.holdSelf = null;
    if (hold) {
      hold.enter();
      await hold.released;
    }
    await route
      .fulfill({
        status: state.selfStatus,
        json:
          state.selfStatus === 200
            ? (state.selfShape?.(self) ?? self)
            : { detail: "Private server detail" },
      })
      .catch(() => {});
  });
  await page.route("**/api/auth/me/profile", async (route) => {
    const actor = state.userId;
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(route.request().method()).toBe("PATCH");
    expect(
      Object.keys(body).every((key) =>
        [
          "display_name",
          "job_title",
          "phone",
          "bio",
          "avatar_file_id",
        ].includes(key),
      ),
    ).toBe(true);
    state.writes.push({
      method: "PATCH",
      path: "/api/auth/me/profile",
      body,
      userId: actor,
    });
    const hold = state.holdPatch;
    state.holdPatch = null;
    if (hold) {
      hold.enter();
      await hold.released;
    }
    if (state.patchStatus !== 200) {
      await route
        .fulfill({
          status: state.patchStatus,
          json: { detail: "Private server detail" },
        })
        .catch(() => {});
      return;
    }
    Object.assign(people.get(actor)!, body);
    const partial = state.partialCleanup && "avatar_file_id" in body;
    await route
      .fulfill({
        status: partial ? 503 : 200,
        json: partial
          ? {
              detail: {
                code: "profile_avatar_cleanup_partial",
                message:
                  "Profile saved; previous avatar deletion requires reconciliation",
              },
            }
          : people.get(actor),
      })
      .catch(() => {});
  });
  await page.route(/\/api\/users\/[^/]+\/preferences$/, async (route) => {
    const userId = new URL(route.request().url()).pathname.split("/")[3]!;
    const write = route.request().method() === "PATCH";
    if (write) {
      const body = route.request().postDataJSON() as {
        theme?: string;
        appearance?: Record<string, unknown>;
      };
      state.writes.push({
        method: "PATCH",
        path: `/api/users/${userId}/preferences`,
        body,
        userId,
      });
      if (state.preferencesWriteStatus === 200) {
        state.theme = body.theme ?? state.theme;
        Object.assign(state.appearance, body.appearance);
      }
    }
    const hold = state.holdPreferences;
    state.holdPreferences = null;
    if (hold) {
      hold.enter();
      await hold.released;
    }
    const status = write
      ? state.preferencesWriteStatus
      : state.preferencesStatus;
    await route.fulfill({
      status,
      json:
        status === 200
          ? {
              user_id: userId,
              theme: state.theme,
              appearance: state.appearance,
            }
          : { detail: "Unavailable" },
    });
  });
  await page.route("**/api/files**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === "/api/files" && method === "POST") {
      const body = request.postDataJSON() as {
        purpose: string;
        filename: string;
        expected_size: number;
      };
      expect(body.purpose).toBe("user_avatar");
      expect(Object.keys(body).sort()).toEqual([
        "expected_size",
        "filename",
        "purpose",
      ]);
      state.writes.push({ method, path, body, userId: state.userId });
      const file = {
        id: avatarFileId,
        ...body,
        creator_id: state.userId,
        record_id: null,
        department_id: null,
        board_id: null,
        actual_size: null,
        media_type: null,
        state: "awaiting_upload",
        failure_code: null,
        is_deleted: false,
        created_at: stamp,
        updated_at: stamp,
      };
      state.files.set(avatarFileId, file);
      return route.fulfill({
        status: 201,
        json: state.fileShape?.(file) ?? file,
      });
    }
    const file = state.files.get(path.split("/")[3]!);
    if (!file)
      return route.fulfill({ status: 404, json: { detail: "File not found" } });
    if (method === "PUT") {
      const actor = state.userId;
      expect(request.headers()["content-type"]).toBe(
        "application/octet-stream",
      );
      expect(request.postDataBuffer()).toEqual(avatarPng);
      state.writes.push({
        method,
        path,
        body: "owned-image-bytes",
        userId: actor,
      });
      const hold = state.holdUpload;
      state.holdUpload = null;
      if (hold) {
        hold.enter();
        await hold.released;
      }
      if (state.uploadStatus !== 200) {
        await route
          .fulfill({
            status: state.uploadStatus,
            json: { detail: "Upload outcome unavailable" },
          })
          .catch(() => {});
        state.uploadCompletions += 1;
        return;
      }
      Object.assign(file, {
        state: "ready",
        actual_size: avatarPng.length,
        media_type: "image/png",
      });
    }
    await route
      .fulfill({ json: state.fileShape?.(file) ?? file })
      .catch(() => {});
    if (method === "PUT") state.uploadCompletions += 1;
  });
  await page.route(/\/api\/users\/[^/]+\/avatar$/, (route) => {
    const actor = new URL(route.request().url()).pathname.split("/")[3]!;
    state.avatarReads.push(actor);
    if (!people.get(actor)?.avatar_file_id)
      return route.fulfill({
        status: 404,
        json: { detail: "Avatar not found" },
      });
    return route.fulfill({
      headers:
        state.avatarFault === "headers"
          ? {}
          : {
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
      contentType: state.avatarFault === "mime" ? "text/html" : "image/png",
      body:
        state.avatarFault === "oversize"
          ? Buffer.alloc(2 * 1024 * 1024 + 1)
          : avatarPng,
    });
  });
  await page.route(/\/api\/users(?:\/[^/]+\/card)?(?:\?|$)/, (route) => {
    state.forbiddenReads.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      status: 403,
      json: { detail: "Profile must use the private self route" },
    });
  });
  await page.route("**/api/auth/sessions", (route) =>
    route.fulfill({
      json: [
        {
          id: "00000000-0000-4000-8000-000000000801",
          created_at: stamp,
          refreshed_at: stamp,
          expires_at: "2099-10-01T00:00:00Z",
          user_agent: "Firefox on Android",
          ip_address: null,
          current: true,
        },
      ],
    }),
  );
  if (options.mfa !== false) {
    await page.route("**/api/auth/mfa", (route) =>
      route.fulfill({
        json: {
          user_id: state.userId,
          assurance_level: "aal1",
          policy_required: false,
          required_since: null,
          enrollment_deadline: null,
          required: false,
          factors: [],
        },
      }),
    );
  }
  return state;
}
