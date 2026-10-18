import { readFileSync } from "node:fs";
import {
  expect,
  test as base,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

type Identity = Readonly<{ email: string; password: string; id: string }>;

type Fixture = Readonly<{
  runId: string;
  baseURL: string;
  mailpitUrl: string;
  admin: Identity;
  member: Identity;
}>;

type SandboxSnapshot = Readonly<{ document: unknown; revision: number }>;

type MemberReplacementResult = Readonly<{
  status: number;
  detail: string | null;
}>;

type AccessEntry = Readonly<{
  department_id: string;
  module_id: string | null;
  level: "read" | "write" | "manage";
}>;

type GroupAccessResponse = AccessEntry &
  Readonly<{
    department_name: string;
    module_name: string | null;
  }>;

type GroupResponse = Readonly<{
  id: string;
  revision: number;
  member_ids: readonly string[];
  access: readonly GroupAccessResponse[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fixture(expectedBaseURL: string | undefined): Fixture {
  const location = process.env.OPENSLATE_FULLSTACK_FIXTURE;
  const runId = process.env.OPENSLATE_FULLSTACK_RUN_ID;
  if (!location || !runId) throw new Error("full-stack fixture is unavailable");

  const parsed: unknown = JSON.parse(readFileSync(location, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.runId !== runId ||
    parsed.baseURL !== expectedBaseURL ||
    typeof parsed.mailpitUrl !== "string" ||
    !isRecord(parsed.admin) ||
    !isRecord(parsed.member)
  )
    throw new Error("full-stack fixture does not match this gateway run");

  const value = parsed as unknown as Fixture;
  if (
    !value.admin.email ||
    !value.admin.password ||
    !value.admin.id ||
    !value.member.email ||
    !value.member.password ||
    !value.member.id
  )
    throw new Error("full-stack identity fixture is malformed");

  const mailpit = new URL(value.mailpitUrl);
  const hostname = mailpit.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    mailpit.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(hostname) ||
    !mailpit.port ||
    mailpit.username ||
    mailpit.password ||
    mailpit.pathname !== "/" ||
    mailpit.search ||
    mailpit.hash
  )
    throw new Error(
      "full-stack fixture Mailpit endpoint must be a loopback origin",
    );

  return value;
}

async function signIn(
  page: Page,
  origin: string,
  credentials: Identity,
): Promise<void> {
  await page.goto(new URL("/login", origin).href);
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(
    (url) =>
      url.origin === new URL(origin).origin &&
      /^\/(openview|sandbox)$/u.test(url.pathname),
  );
}

async function getJson<T>(page: Page, path: string): Promise<T> {
  const result = await page.evaluate(async (endpoint) => {
    const response = await fetch(endpoint, {
      cache: "no-store",
      credentials: "same-origin",
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // The status assertion below reports an unsuccessful response without
      // putting an arbitrary response body into the Playwright output.
    }
    return { status: response.status, body };
  }, path);
  expect(result.status, `GET ${path} should succeed`).toBe(200);
  return result.body as T;
}

async function readSandboxSnapshot(page: Page): Promise<SandboxSnapshot> {
  return page.evaluate(async () => {
    const response = await fetch("/api/sandbox/document", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok)
      throw new Error(`Sandbox draft read returned ${response.status}`);
    const payload: unknown = await response.json();
    if (
      !isRecordInPage(payload) ||
      typeof payload.revision !== "number" ||
      !Object.hasOwn(payload, "document")
    )
      throw new Error("Sandbox draft response was malformed");
    return { document: payload.document, revision: payload.revision };

    function isRecordInPage(value: unknown): value is Record<string, unknown> {
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    }
  });
}

async function restoreSandboxSnapshot(
  page: Page,
  snapshot: SandboxSnapshot,
): Promise<void> {
  const result = await page.evaluate(async (originalDocument) => {
    const currentResponse = await fetch("/api/sandbox/document", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!currentResponse.ok)
      return { readStatus: currentResponse.status, writeStatus: 0 };
    const current: unknown = await currentResponse.json();
    if (
      typeof current !== "object" ||
      current === null ||
      !("revision" in current) ||
      typeof current.revision !== "number"
    )
      return { readStatus: currentResponse.status, writeStatus: 0 };

    const cookie = document.cookie
      .split(";")
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("openslate_csrf="));
    if (!cookie) return { readStatus: currentResponse.status, writeStatus: 0 };
    const csrfToken = decodeURIComponent(
      cookie.slice("openslate_csrf=".length),
    );
    const writeResponse = await fetch("/api/sandbox/document", {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({
        expectedRevision: current.revision,
        document: originalDocument,
      }),
    });
    return {
      readStatus: currentResponse.status,
      writeStatus: writeResponse.status,
    };
  }, snapshot.document);
  expect(
    result.readStatus,
    "current Sandbox revision should be available",
  ).toBe(200);
  expect(result.writeStatus, "original Sandbox draft should be restored").toBe(
    200,
  );
}

async function publishDraft(
  page: Page,
  password: string,
  onPublished?: () => void,
): Promise<void> {
  const preview = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/sandbox/publication-previews" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Review & Publish" }).click();
  expect((await preview).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
  await page.getByLabel("Your password", { exact: true }).fill(password);

  const publication = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sandbox/publications" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Publish changes" }).click();
  const response = await publication;
  expect(response.status()).toBe(201);
  onPublished?.();
  await expect(
    page.getByText("Changes published", { exact: true }),
  ).toBeVisible();
}

async function addDepartment(page: Page, name: string): Promise<void> {
  await page
    .getByRole("complementary", { name: "Design workbench" })
    .getByRole("tablist", { name: "Workbench view" })
    .getByRole("tab", { name: "Structure" })
    .click();
  const structure = page.getByRole("complementary", {
    name: "Organization structure",
  });
  await expect(structure).toBeVisible();
  await structure
    .getByRole("button", { name: "Add department", exact: true })
    .click();
  await page.getByLabel("Department name", { exact: true }).fill(name);
  await page
    .getByRole("button", { name: "Create department", exact: true })
    .click();
  // A created item shows in place: Properties opens on it.
  await expect(
    page.getByRole("heading", { name, level: 2, exact: true }),
  ).toBeVisible();
}

async function addModuleAndField(
  page: Page,
  moduleName: string,
  fieldName: string,
): Promise<void> {
  await page.getByRole("button", { name: "Add module", exact: true }).click();
  await page.getByLabel("Module name", { exact: true }).fill(moduleName);
  await page
    .getByRole("button", { name: "Create module", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: moduleName, level: 2, exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add field", exact: true }).click();
  await page.getByLabel("Field name", { exact: true }).fill(fieldName);
  await page.getByRole("button", { name: "Create field", exact: true }).click();
  await expect(
    page.getByRole("group", {
      name: `${fieldName} field settings`,
      exact: true,
    }),
  ).toBeVisible();
}

type DepartmentPage = Readonly<{
  items: readonly Readonly<{ id: string; department_name: string }>[];
  pagination: Readonly<{ has_more: boolean }>;
}>;

type ModulePage = Readonly<{
  items: readonly Readonly<{
    id: string;
    department_id: string;
    module_name: string;
  }>[];
  pagination: Readonly<{ has_more: boolean }>;
}>;

async function publishedIds(
  page: Page,
  managedDepartmentName: string,
  unrelatedDepartmentName: string,
  moduleName: string,
): Promise<
  Readonly<{
    departmentId: string;
    unrelatedDepartmentId: string;
    moduleId: string;
  }>
> {
  const departments = await getJson<DepartmentPage>(
    page,
    "/api/departments?limit=100&offset=0",
  );
  const modules = await getJson<ModulePage>(
    page,
    "/api/modules?limit=100&offset=0",
  );
  expect(departments.pagination.has_more).toBe(false);
  expect(modules.pagination.has_more).toBe(false);

  const managedMatches = departments.items.filter(
    (item) => item.department_name === managedDepartmentName,
  );
  const unrelatedMatches = departments.items.filter(
    (item) => item.department_name === unrelatedDepartmentName,
  );
  expect(managedMatches).toHaveLength(1);
  expect(unrelatedMatches).toHaveLength(1);
  const departmentId = managedMatches[0]!.id;
  const foundModules = modules.items.filter(
    (item) =>
      item.department_id === departmentId && item.module_name === moduleName,
  );
  expect(foundModules).toHaveLength(1);
  return {
    departmentId,
    unrelatedDepartmentId: unrelatedMatches[0]!.id,
    moduleId: foundModules[0]!.id,
  };
}

type GroupRead = Readonly<{
  status: number;
  etag: string | null;
  group: GroupResponse | null;
}>;

async function readGroup(page: Page, groupId: string): Promise<GroupRead> {
  return page.evaluate(async (id) => {
    const response = await fetch(
      `/api/access/groups/${encodeURIComponent(id)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    let group: GroupResponse | null = null;
    try {
      group = (await response.json()) as GroupResponse;
    } catch {
      // Return only status and ETag for safe, actionable failures.
    }
    return {
      status: response.status,
      etag: response.headers.get("ETag"),
      group,
    };
  }, groupId);
}

async function replaceGroupMembersAsManager(
  page: Page,
  groupId: string,
  memberIds: readonly string[],
  etag: string,
): Promise<MemberReplacementResult> {
  return page.evaluate(
    async ({ id, members, expectedEtag }) => {
      const cookie = document.cookie
        .split(";")
        .map((segment) => segment.trim())
        .find((segment) => segment.startsWith("openslate_csrf="));
      if (!cookie) return { status: 0, detail: null };
      const csrfToken = decodeURIComponent(
        cookie.slice("openslate_csrf=".length),
      );
      const response = await fetch(
        `/api/access/groups/${encodeURIComponent(id)}/members`,
        {
          method: "PUT",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "If-Match": expectedEtag,
            "X-CSRF-Token": csrfToken,
          },
          body: JSON.stringify({ member_ids: members }),
        },
      );
      let detail: string | null = null;
      if (!response.ok) {
        try {
          const payload: unknown = await response.json();
          if (
            typeof payload === "object" &&
            payload !== null &&
            "detail" in payload &&
            typeof payload.detail === "string"
          )
            detail = payload.detail;
        } catch {
          // The status remains useful if the error response has no JSON body.
        }
      }
      return { status: response.status, detail };
    },
    { id: groupId, members: [...memberIds], expectedEtag: etag },
  );
}

async function createGroup(
  page: Page,
  name: string,
  departmentName: string,
  departmentId: string,
  memberEmail: string | undefined,
  ownedGroupIds: string[],
): Promise<string> {
  const createGroupButton = page
    .getByRole("button", { name: "Create group", exact: true })
    .first();
  await expect(createGroupButton).toBeEnabled();
  await createGroupButton.click();
  const createDialog = page.getByRole("dialog", { name: "Create a group" });
  await createDialog.getByLabel("Name", { exact: true }).fill(name);
  if (memberEmail) {
    await createDialog.getByLabel("Search people to add").fill(memberEmail);
    const memberRow = createDialog
      .getByRole("list", { name: "People to add" })
      .getByRole("listitem")
      .filter({ hasText: memberEmail });
    await expect(memberRow).toHaveCount(1);
    await memberRow.getByRole("button", { name: /^Add /u }).click();
    await expect(
      createDialog
        .getByRole("list", { name: "Members" })
        .getByText(memberEmail),
    ).toBeVisible();
  }
  await createDialog
    .getByRole("button", { name: "Create group", exact: true })
    .click();

  const groupPanel = page.getByRole("dialog", { name, exact: true });
  await expect(groupPanel).toBeVisible();
  const groupId = new URL(page.url()).searchParams.get("group");
  expect(groupId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  if (!groupId)
    throw new Error("created group URL did not include its identifier");
  ownedGroupIds.push(groupId);

  await groupPanel.getByRole("tab", { name: "Access", exact: true }).click();
  await groupPanel
    .getByLabel(`${departmentName} level`, { exact: true })
    .selectOption("manage");
  const save = groupPanel.getByRole("button", {
    name: "Save access",
    exact: true,
  });
  await save.click();
  await expect(save).toBeDisabled();

  const saved = await readGroup(page, groupId);
  expect(saved.status).toBe(200);
  expect(saved.group?.access).toContainEqual({
    department_id: departmentId,
    department_name: departmentName,
    module_id: null,
    module_name: null,
    level: "manage",
  });
  return groupId;
}

async function closeGroupPanel(page: Page, name: string): Promise<void> {
  const groupPanel = page.getByRole("dialog", { name, exact: true });
  await groupPanel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(groupPanel).toBeHidden();
}

async function hasMailpitRecipient(
  request: APIRequestContext,
  mailpitOrigin: URL,
  email: string,
): Promise<boolean> {
  const response = await request.get(
    new URL("/api/v1/messages", mailpitOrigin).href,
    { timeout: 2_500 },
  );
  if (!response.ok()) return false;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return false;
  }
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return false;
  return payload.messages.some(
    (message) =>
      isRecord(message) &&
      Array.isArray(message.To) &&
      message.To.some(
        (recipient) =>
          isRecord(recipient) &&
          typeof recipient.Address === "string" &&
          recipient.Address.toLowerCase() === email.toLowerCase(),
      ),
  );
}

async function clearAndDeleteGroup(page: Page, groupId: string): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const cookie = document.cookie
      .split(";")
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("openslate_csrf="));
    if (!cookie) return { readStatus: 0, clearStatus: 0, deleteStatus: 0 };
    const csrfToken = decodeURIComponent(
      cookie.slice("openslate_csrf=".length),
    );
    const path = `/api/access/groups/${encodeURIComponent(id)}`;
    const read = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (read.status === 404)
      return { readStatus: 404, clearStatus: 204, deleteStatus: 204 };
    if (!read.ok)
      return { readStatus: read.status, clearStatus: 0, deleteStatus: 0 };
    const etag = read.headers.get("ETag");
    if (!etag)
      return { readStatus: read.status, clearStatus: 0, deleteStatus: 0 };
    const clear = await fetch(`${path}/members`, {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "If-Match": etag,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ member_ids: [] }),
    });
    if (!clear.ok)
      return {
        readStatus: read.status,
        clearStatus: clear.status,
        deleteStatus: 0,
      };
    const nextEtag = clear.headers.get("ETag");
    if (!nextEtag)
      return {
        readStatus: read.status,
        clearStatus: clear.status,
        deleteStatus: 0,
      };
    const deletion = await fetch(path, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "If-Match": nextEtag, "X-CSRF-Token": csrfToken },
    });
    return {
      readStatus: read.status,
      clearStatus: clear.status,
      deleteStatus: deletion.status,
    };
  }, groupId);
  expect(result.readStatus).toBe(200);
  expect(result.clearStatus).toBe(200);
  expect(result.deleteStatus).toBe(204);
}

async function retirePendingInvite(page: Page, userId: string): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const cookie = document.cookie
      .split(";")
      .map((segment) => segment.trim())
      .find((segment) => segment.startsWith("openslate_csrf="));
    if (!cookie) return { revokeStatus: 0, deleteStatus: 0 };
    const csrfToken = decodeURIComponent(
      cookie.slice("openslate_csrf=".length),
    );
    const headers = { "X-CSRF-Token": csrfToken };
    const revoke = await fetch(
      `/api/auth/invitations/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        credentials: "same-origin",
        headers,
      },
    );
    if (!revoke.ok) return { revokeStatus: revoke.status, deleteStatus: 0 };
    const deletion = await fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers,
    });
    return { revokeStatus: revoke.status, deleteStatus: deletion.status };
  }, userId);
  expect(result.revokeStatus).toBe(204);
  expect(result.deleteStatus).toBe(204);
}

type AccessJourney = {
  page: Page;
  runFixture: Fixture;
  ownedGroupIds: string[];
  pendingUserId?: string;
  managerContext?: BrowserContext;
  sandboxSnapshot?: SandboxSnapshot;
  sandboxTouched: boolean;
  sandboxPublished: boolean;
  initialMemberAccess?: unknown;
  published?: Awaited<ReturnType<typeof publishedIds>>;
  managerGroupId?: string;
  unrelatedGroupId?: string;
  unrelatedGroup?: GroupRead;
};

const test = base.extend<Record<never, never>, { journey: AccessJourney }>({
  journey: [
    async ({ browser }, provide, workerInfo) => {
      const runFixture = fixture(workerInfo.project.use.baseURL);
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({
          baseURL: workerInfo.project.use.baseURL,
          ignoreHTTPSErrors: workerInfo.project.use.ignoreHTTPSErrors,
        });
        const page = await context.newPage();
        await provide({
          page,
          runFixture,
          ownedGroupIds: [],
          sandboxTouched: false,
          sandboxPublished: false,
        });
      } finally {
        await context?.close();
      }
    },
    { scope: "worker" },
  ],
});

test.use({ trace: "off", screenshot: "off", video: "off" });

function requirePublished(journey: AccessJourney) {
  if (!journey.published)
    throw new Error("the ordered Access journey has no published departments");
  return journey.published;
}

test.describe("Access", () => {
  test.describe.configure({ mode: "serial" });

  test.afterAll(async ({ journey }) => {
    const {
      page,
      runFixture,
      managerContext,
      ownedGroupIds,
      pendingUserId,
      sandboxSnapshot,
      sandboxTouched,
      sandboxPublished,
      initialMemberAccess,
    } = journey;
    const cleanupFailures: string[] = [];
    if (managerContext) {
      try {
        await managerContext.close();
      } catch {
        cleanupFailures.push("manager browser context did not close");
      }
    }
    for (const groupId of [...ownedGroupIds].reverse()) {
      try {
        await clearAndDeleteGroup(page, groupId);
      } catch {
        cleanupFailures.push("a generated Access group could not be removed");
      }
    }
    if (pendingUserId) {
      try {
        await retirePendingInvite(page, pendingUserId);
      } catch {
        cleanupFailures.push(
          "the generated pending invitation could not be retired",
        );
      }
    }
    if (sandboxTouched && sandboxSnapshot) {
      try {
        await restoreSandboxSnapshot(page, sandboxSnapshot);
        if (sandboxPublished) {
          await page.goto("/sandbox?section=designer");
          await expect(
            page.getByRole("heading", { name: "Sandbox", exact: true }),
          ).toBeVisible();
          await publishDraft(page, runFixture.admin.password);
        }
      } catch {
        cleanupFailures.push(
          "the original Sandbox draft/catalog could not be restored",
        );
      }
    }
    if (initialMemberAccess !== undefined) {
      try {
        const restoredMemberAccess = await getJson<unknown>(
          page,
          `/api/users/${encodeURIComponent(runFixture.member.id)}/access`,
        );
        expect(restoredMemberAccess).toEqual(initialMemberAccess);
      } catch {
        cleanupFailures.push(
          "the seeded member's original effective access changed",
        );
      }
    }
    if (cleanupFailures.length)
      throw new Error(
        `Access acceptance cleanup failed: ${cleanupFailures.join("; ")}`,
      );
  });

  test("Publish managed and unrelated departments", async ({ journey }) => {
    const { page, runFixture } = journey;
    const suffix = runFixture.runId.slice(0, 8);
    const managedDepartment = `E2E Managed ${suffix}`;
    const unrelatedDepartment = `E2E Unrelated ${suffix}`;
    const managedModule = `E2E Records ${suffix}`;
    await signIn(page, runFixture.baseURL, runFixture.admin);
    journey.initialMemberAccess = await getJson<unknown>(
      page,
      `/api/users/${encodeURIComponent(runFixture.member.id)}/access`,
    );
    journey.sandboxSnapshot = await readSandboxSnapshot(page);

    await page.goto("/sandbox?section=designer");
    await expect(
      page.getByRole("heading", { name: "Sandbox", exact: true }),
    ).toBeVisible();
    journey.sandboxTouched = true;
    await addDepartment(page, managedDepartment);
    await addModuleAndField(page, managedModule, `E2E Name ${suffix}`);
    await addDepartment(page, unrelatedDepartment);
    await publishDraft(page, runFixture.admin.password, () => {
      journey.sandboxPublished = true;
    });

    const { departmentId, unrelatedDepartmentId, moduleId } =
      await publishedIds(
        page,
        managedDepartment,
        unrelatedDepartment,
        managedModule,
      );
    journey.published = { departmentId, unrelatedDepartmentId, moduleId };
    expect(departmentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(moduleId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  test("Create scoped manager and unrelated groups", async ({ journey }) => {
    const { page, runFixture, ownedGroupIds } = journey;
    const { departmentId, unrelatedDepartmentId } = requirePublished(journey);
    const suffix = runFixture.runId.slice(0, 8);
    const managedDepartment = `E2E Managed ${suffix}`;
    const unrelatedDepartment = `E2E Unrelated ${suffix}`;
    const managerGroupName = `E2E Managers ${suffix}`;
    const unrelatedGroupName = `E2E Other Group ${suffix}`;
    await page.goto("/access?view=groups");
    await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
    const managerGroupId = await createGroup(
      page,
      managerGroupName,
      managedDepartment,
      departmentId,
      runFixture.member.email,
      ownedGroupIds,
    );
    journey.managerGroupId = managerGroupId;
    const managerGroup = await readGroup(page, managerGroupId);
    expect(managerGroup.status).toBe(200);
    expect(managerGroup.group?.member_ids).toContain(runFixture.member.id);
    expect(managerGroup.group?.access).toContainEqual({
      department_id: departmentId,
      department_name: managedDepartment,
      module_id: null,
      module_name: null,
      level: "manage",
    });
    await closeGroupPanel(page, managerGroupName);

    const unrelatedGroupId = await createGroup(
      page,
      unrelatedGroupName,
      unrelatedDepartment,
      unrelatedDepartmentId,
      undefined,
      ownedGroupIds,
    );
    journey.unrelatedGroupId = unrelatedGroupId;
    const unrelatedGroup = await readGroup(page, unrelatedGroupId);
    journey.unrelatedGroup = unrelatedGroup;
    expect(unrelatedGroup.status).toBe(200);
    expect(unrelatedGroup.group?.id).toBe(unrelatedGroupId);
    expect(unrelatedGroup.group?.member_ids).toEqual([]);
    expect(unrelatedGroup.group?.access).toContainEqual({
      department_id: unrelatedDepartmentId,
      department_name: unrelatedDepartment,
      module_id: null,
      module_name: null,
      level: "manage",
    });
    expect(unrelatedGroup.group?.revision).toBeGreaterThan(0);
    expect(unrelatedGroup.etag).toBeTruthy();
    await closeGroupPanel(page, unrelatedGroupName);
  });

  test("Invite pending person and confirm Mailpit", async ({ journey }) => {
    const { page, runFixture } = journey;
    const { departmentId } = requirePublished(journey);
    if (!journey.managerGroupId || !journey.unrelatedGroup)
      throw new Error("the ordered Access journey has no generated groups");
    const suffix = runFixture.runId.slice(0, 8);
    const managerGroupName = `E2E Managers ${suffix}`;
    const pendingName = `Pending Access ${suffix}`;
    const pendingEmail = `access-pending-${runFixture.runId}@example.com`;
    const mailpitOrigin = new URL(runFixture.mailpitUrl);
    const request = page.request;
    await page.goto("/access?view=people");
    await expect(
      page.getByRole("heading", { name: "People", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Invite person" }).click();
    const inviteDialog = page.getByRole("dialog", { name: "Invite a person" });
    await inviteDialog.getByLabel("Email", { exact: true }).fill(pendingEmail);
    await inviteDialog.getByLabel("Name", { exact: true }).fill(pendingName);
    await inviteDialog
      .getByRole("checkbox", { name: managerGroupName })
      .click();
    const invitation = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/invitations" &&
        response.request().method() === "POST",
    );
    await inviteDialog.getByRole("button", { name: "Send invitation" }).click();
    const invitationResponse = await invitation;
    expect(invitationResponse.status()).toBe(201);
    const invitationPayload: unknown = await invitationResponse.json();
    if (
      !isRecord(invitationPayload) ||
      !isRecord(invitationPayload.user) ||
      typeof invitationPayload.user.id !== "string" ||
      invitationPayload.user.email !== pendingEmail ||
      invitationPayload.user.status !== "pending"
    )
      throw new Error(
        "invitation response did not contain the generated pending user",
      );
    const pendingUserId = invitationPayload.user.id;
    journey.pendingUserId = pendingUserId;
    await expect(inviteDialog).toBeHidden();
    await expect(
      page
        .getByRole("table", { name: "People" })
        .getByRole("row", { name: new RegExp(pendingName, "u") }),
    ).toContainText("Pending");
    await expect
      .poll(() => hasMailpitRecipient(request, mailpitOrigin, pendingEmail), {
        timeout: 10_000,
        intervals: [100, 250, 500],
      })
      .toBe(true);

    const invitedUser = await getJson<
      Readonly<{ email: string; status: string }>
    >(page, `/api/users/${encodeURIComponent(pendingUserId)}`);
    expect(invitedUser).toMatchObject({
      email: pendingEmail,
      status: "pending",
    });
    const effective = await getJson<
      Readonly<{
        user_id: string;
        entries: readonly AccessEntry[];
      }>
    >(page, `/api/users/${encodeURIComponent(runFixture.member.id)}/access`);
    expect(effective.user_id).toBe(runFixture.member.id);
    expect(effective.entries).toContainEqual({
      department_id: departmentId,
      module_id: null,
      level: "manage",
      groups: expect.any(Array),
    });
  });

  test("Manager membership control and unrelated 403", async ({
    journey,
    browser,
  }) => {
    const {
      page,
      runFixture,
      managerGroupId,
      unrelatedGroupId,
      unrelatedGroup,
      pendingUserId,
    } = journey;
    const { departmentId, moduleId } = requirePublished(journey);
    if (!managerGroupId || !unrelatedGroupId || !unrelatedGroup)
      throw new Error(
        "the ordered Access journey has no original group snapshot",
      );
    const suffix = runFixture.runId.slice(0, 8);
    const managerGroupName = `E2E Managers ${suffix}`;
    const unrelatedGroupName = `E2E Other Group ${suffix}`;
    const pendingName = `Pending Access ${suffix}`;
    const managerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
    });
    journey.managerContext = managerContext;
    const managerPage = await managerContext.newPage();
    await signIn(managerPage, runFixture.baseURL, runFixture.member);
    await managerPage.goto(
      new URL("/access?view=groups", runFixture.baseURL).href,
    );
    await expect(
      managerPage.getByRole("heading", { name: "Groups" }),
    ).toBeVisible();
    await expect(
      managerPage.getByRole("button", { name: managerGroupName, exact: true }),
    ).toBeVisible();
    await expect(
      managerPage.getByText(unrelatedGroupName, { exact: true }),
    ).toHaveCount(0);
    await managerPage.goto(
      new URL(
        `/access?view=groups&group=${encodeURIComponent(managerGroupId)}&tab=members`,
        runFixture.baseURL,
      ).href,
    );
    const managerPanel = managerPage.getByRole("dialog", {
      name: managerGroupName,
      exact: true,
    });
    await expect(managerPanel).toBeVisible();
    await managerPanel
      .getByRole("button", { name: `Remove ${pendingName}`, exact: true })
      .click();
    const saveMembers = managerPanel.getByRole("button", {
      name: "Save members",
      exact: true,
    });
    await saveMembers.click();
    await expect(saveMembers).toBeDisabled();

    const managerIdentity = await getJson<
      Readonly<{
        id: string;
        access: readonly AccessEntry[];
      }>
    >(managerPage, "/api/auth/me");
    expect(managerIdentity.id).toBe(runFixture.member.id);
    expect(managerIdentity.access).toContainEqual({
      department_id: departmentId,
      module_id: null,
      level: "manage",
    });
    const managerModules = await getJson<ModulePage>(
      managerPage,
      `/api/modules?limit=100&offset=0&department_id=${encodeURIComponent(departmentId)}`,
    );
    expect(
      managerModules.items.some(
        (item) => item.id === moduleId && item.department_id === departmentId,
      ),
    ).toBe(true);

    const changedManagerGroup = await readGroup(page, managerGroupId);
    expect(changedManagerGroup.status).toBe(200);
    expect(changedManagerGroup.group?.member_ids).toEqual([
      runFixture.member.id,
    ]);
    expect(changedManagerGroup.etag).toBeTruthy();
    if (!changedManagerGroup.etag)
      throw new Error("updated manager group has no ETag");
    if (!pendingUserId)
      throw new Error("generated pending invite identifier is unavailable");

    // This actual authorized membership addition uses the exact fetch, cookie,
    // CSRF and If-Match path used below, so the following 403 cannot be a
    // request-origin or CSRF rejection.
    const authorizedControl = await replaceGroupMembersAsManager(
      managerPage,
      managerGroupId,
      [runFixture.member.id, pendingUserId],
      changedManagerGroup.etag,
    );
    expect(authorizedControl.status).toBe(200);
    const persistedControl = await readGroup(page, managerGroupId);
    expect(persistedControl.status).toBe(200);
    expect(persistedControl.group?.revision).toBeGreaterThan(
      changedManagerGroup.group?.revision ?? 0,
    );
    expect(persistedControl.group?.member_ids).toHaveLength(2);
    expect(persistedControl.group?.member_ids).toEqual(
      expect.arrayContaining([runFixture.member.id, pendingUserId]),
    );

    expect(unrelatedGroup.group?.id).toBe(unrelatedGroupId);
    expect(unrelatedGroup.group?.revision).toBeGreaterThan(0);
    expect(unrelatedGroup.etag).toBeTruthy();
    if (!unrelatedGroup.etag)
      throw new Error("admin-read unrelated group has no ETag");
    const unauthorizedAttempt = await replaceGroupMembersAsManager(
      managerPage,
      unrelatedGroupId,
      [runFixture.member.id],
      unrelatedGroup.etag,
    );
    expect(unauthorizedAttempt.status).toBe(403);
    expect(unauthorizedAttempt.detail).toBe("Forbidden");
    const unchangedUnrelatedGroup = await readGroup(page, unrelatedGroupId);
    expect(unchangedUnrelatedGroup.status).toBe(200);
    expect(unchangedUnrelatedGroup.group?.id).toBe(unrelatedGroupId);
    expect(unchangedUnrelatedGroup.group?.revision).toBe(
      unrelatedGroup.group?.revision,
    );
    expect(unchangedUnrelatedGroup.group?.member_ids).toEqual(
      unrelatedGroup.group?.member_ids,
    );
  });
});
