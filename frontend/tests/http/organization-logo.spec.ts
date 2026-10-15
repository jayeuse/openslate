import { expect, heldResponse, test, type Page } from "./helpers/test";
import {
  installLogoApi,
  logoFile,
  oldLogoId,
  png,
} from "./helpers/workspace-logo";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";

test.use({ trace: "off", screenshot: "off", video: "off" });
const untrustedLogoMessage = "untrusted-logo-response-canary";
const save = (page: Page) =>
  page.getByRole("button", { name: /^(Save settings|Save again)$/ });
const pick = (
  page: Page,
  name = "harbor.png",
  buffer = png,
  mimeType = "image/png",
) =>
  page
    .getByLabel("Organization logo", { exact: true })
    .setInputFiles({ name, mimeType, buffer });
const preview = (page: Page) =>
  page.getByRole("region", { name: "Workspace preview" });
const header = (page: Page) =>
  page.getByRole("complementary", { name: "Primary sidebar" });
const patches = (api: Awaited<ReturnType<typeof installLogoApi>>) =>
  api.writes.filter(({ path }) => path === "/workspace");
const field = (page: Page, name: string) =>
  page.getByLabel(name, { exact: true });
const look = (page: Page) =>
  page.getByRole("radiogroup", { name: "Organization look" });
const radio = (page: Page, name: string) =>
  look(page).getByRole("radio", { name: new RegExp(`^${name}`) });

test("Logo draft stays local until settings save, then saved header and removal use the committed brand", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  await page.goto("/manage?view=organization");
  const mark = page.getByRole("textbox", {
    name: "Organization mark",
    exact: true,
  });
  await expect(mark).toHaveAttribute("maxlength", "3");
  const fullMark = "HOP";
  await mark.fill(fullMark);
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Harbor Operations");
  await pick(
    page,
    "harbor.png",
    Buffer.concat([png, Buffer.from("owned metadata")]),
  );
  await expect(
    preview(page).getByRole("img", {
      name: "Harbor Operations logo",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("link", {
      name: "Harbor Services workspace",
      exact: true,
    }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
  await save(page).click();
  await expect(
    page.getByText("Organization settings saved.", { exact: true }),
  ).toBeVisible();
  // The fake File API names its first reservation with this id.
  const committed = "44444444-4444-4444-8444-000000000001";
  expect(patches(api)[0].body).toEqual({
    revision: 4,
    display_name: "Harbor Operations",
    mark: fullMark,
    logo_file_id: committed,
  });
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Operations logo",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(mark).toHaveValue(fullMark);
  await page.getByRole("button", { name: "Remove logo", exact: true }).click();
  await save(page).click();
  await expect(
    header(page).getByRole("img", {
      name: `Harbor Operations mark: ${fullMark}`,
      exact: true,
    }),
  ).toBeVisible();
  expect(patches(api)[1].body).toEqual({ revision: 5, logo_file_id: null });
  expect(api.files.get(committed)?.state).toBe("purged");
  const bounds = await header(page)
    .getByRole("img", {
      name: `Harbor Operations mark: ${fullMark}`,
      exact: true,
    })
    .evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
});

test("Logo a direct Comms visit loads the organization brand", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.workspace.logo_file_id = oldLogoId;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  await page.goto("/comms");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("img", { name: "OpenSlate mark: OS", exact: true }),
  ).toHaveCount(0);
});

test("Logo warm workspace cache shows the organization brand in Comms and on return", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.workspace.logo_file_id = oldLogoId;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  await page.goto("/manage?view=organization");
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "OpenComms", exact: true }).click();
  await expect(page).toHaveURL(/\/comms$/);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("img", { name: "OpenSlate mark: OS", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(page).toHaveURL(/\/manage\?view=organization$/);
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
});

test("Logo selection is discarded without reserving a File or changing the saved header", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  await page.goto("/manage?view=organization");
  await pick(page);
  await expect(
    preview(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    preview(page).getByRole("img", {
      name: "Harbor Services mark: HS",
      exact: true,
    }),
  ).toBeVisible();
  expect(api.writes).toEqual([]);
});

// The size limits are rows of isolated/shell/workspace-logo-api.spec.ts.
for (const [name, buffer, mimeType] of [
  ["vector.svg", Buffer.from("<svg/>"), "image/svg+xml"],
] as const) {
  test(`Logo rejects ${name} before reservation and preserves other settings drafts`, async ({
    page,
  }) => {
    const api = await installLogoApi(page);
    await page.goto("/manage?view=organization");
    await page
      .getByLabel("Description", { exact: true })
      .fill("Retained draft");
    await pick(page, name, buffer, mimeType);
    await expect(
      page.getByText("Choose a PNG or JPEG between 1 byte and 2 MB.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
      "Retained draft",
    );
    expect(api.writes).toEqual([]);
  });
}

test("Logo partial cleanup shows committed settings and retries only the captured old File", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.workspace.logo_file_id = oldLogoId;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  api.failure = "partial";
  await page.goto("/manage?view=organization");
  await pick(page);
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Saved despite cleanup");
  await save(page).click();
  const cleanupNotice = page.getByRole("status").filter({
    hasText: "Logo saved. The old logo will be removed shortly.",
  });
  await expect(cleanupNotice).toBeVisible();
  await expect(
    page.getByLabel("Organization logo", { exact: true }),
  ).not.toHaveAttribute("aria-invalid", "true");
  await expect(
    header(page).getByRole("img", {
      name: "Saved despite cleanup logo",
      exact: true,
    }),
  ).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await cleanupNotice
    .getByRole("button", { name: "Retry cleanup", exact: true })
    .click();
  await expect(
    page.getByText("Previous logo cleanup completed.", { exact: true }),
  ).toBeVisible();
  await expect(cleanupNotice).toHaveCount(0);
  expect(patches(api)).toHaveLength(1);
  expect(
    api.writes
      .filter(({ path }) => path.endsWith("/reconcile"))
      .map(({ path }) => path),
  ).toEqual([`/files/${oldLogoId}/reconcile`]);
  expect(api.files.get(oldLogoId)?.state).toBe("purged");
});

for (const committed of [true, false]) {
  test(`Logo interrupted PATCH reads back ${committed ? "committed" : "uncommitted"} settings before another save`, async ({
    page,
  }) => {
    const api = await installLogoApi(page);
    api.failure = committed ? "lost" : "before";
    await page.goto("/manage?view=organization");
    await pick(page);
    await page
      .getByLabel("Description", { exact: true })
      .fill("Readback description");
    await save(page).click();
    if (committed) {
      await expect(
        header(page).getByRole("img", {
          name: "Harbor Services logo",
          exact: true,
        }),
      ).toBeVisible();
      await expect(save(page)).toBeDisabled();
    } else {
      await expect(
        page.getByText("The settings could not be saved. Try again.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
        "Readback description",
      );
      await save(page).click();
      await expect(
        header(page).getByRole("img", {
          name: "Harbor Services logo",
          exact: true,
        }),
      ).toBeVisible();
    }
    expect(api.writes.filter(({ path }) => path === "/files")).toHaveLength(1);
    expect(
      api.writes.filter(({ path }) => path.endsWith("/content")),
    ).toHaveLength(1);
    expect(patches(api)).toHaveLength(committed ? 1 : 2);
  });
}

test("Logo unresolved upload keeps its reservation and requires an explicit check before publishing", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.uploadUnresolved = true;
  await page.goto("/manage?view=organization");
  await pick(page);
  await save(page).click();
  await expect(
    page.getByRole("button", { name: "Check upload", exact: true }),
  ).toBeVisible();
  expect(patches(api)).toEqual([]);
  api.onFileRead = (route) =>
    route.fulfill({
      status: 503,
      json: { detail: { code: "unavailable", message: untrustedLogoMessage } },
    });
  await page.getByRole("button", { name: "Check upload", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "This service is temporarily unavailable. Try again.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(untrustedLogoMessage, { exact: true }),
  ).toHaveCount(0);
  expect(patches(api)).toEqual([]);
  api.onFileRead = null;
  await page.getByRole("button", { name: "Check upload", exact: true }).click();
  await expect(
    page.getByText("Logo upload confirmed. Save settings to use it.", {
      exact: true,
    }),
  ).toBeVisible();
  await save(page).click();
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  expect(api.writes.filter(({ path }) => path === "/files")).toHaveLength(1);
  expect(
    api.writes.filter(({ path }) => path.endsWith("/content")),
  ).toHaveLength(1);
});

test("Logo stale revision preserves the ready candidate and settings draft for explicit Save again", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.failure = "stale";
  await page.goto("/manage?view=organization");
  await pick(page);
  await page
    .getByLabel("Description", { exact: true })
    .fill("Preserved on conflict");
  await save(page).click();
  await expect(
    page.getByText(/Workspace settings changed\. The latest values are loaded/),
  ).toBeVisible();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Preserved on conflict",
  );
  api.onFileRead = (route) =>
    route.fulfill({
      status: 503,
      json: { detail: { code: "unavailable", message: untrustedLogoMessage } },
    });
  await save(page).click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "This service is temporarily unavailable. Try again.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(untrustedLogoMessage, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue(
    "Preserved on conflict",
  );
  expect(patches(api)).toHaveLength(1);
  api.onFileRead = null;
  await save(page).click();
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  expect(patches(api)[1].body?.revision).toBe(5);
  expect(api.writes.filter(({ path }) => path === "/files")).toHaveLength(1);
});

test("Logo retained-candidate refusal rechecks the session before any further publish", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.failure = "stale";
  await page.goto("/manage?view=organization");
  await pick(page);
  await save(page).click();
  await expect(
    page.getByText(/Workspace settings changed\. The latest values are loaded/),
  ).toBeVisible();
  const sessionsBeforeRefusal = api.sessionReads;
  const gate = heldResponse();
  api.onSession = async (route) => {
    await gate.released;
    await route.fulfill({
      json: { authenticated: true, user_id: api.actor, setup_required: false },
    });
  };
  api.onFileRead = (route) =>
    route.fulfill({
      status: 403,
      json: { detail: { code: "forbidden", message: untrustedLogoMessage } },
    });
  try {
    await save(page).click();
    const curtain = page.getByRole("dialog", {
      name: "Session verification",
      exact: true,
    });
    await expect(curtain).toBeVisible();
    await expect.poll(() => api.sessionReads).toBe(sessionsBeforeRefusal + 1);
    await expect(
      page.getByText(untrustedLogoMessage, { exact: true }),
    ).toHaveCount(0);
    expect(patches(api)).toHaveLength(1);
    expect(api.writes.filter(({ path }) => path === "/files")).toHaveLength(1);
    api.onFileRead = null;
    gate.release();
    await expect(curtain).toBeHidden();
    expect(patches(api)).toHaveLength(1);
  } finally {
    gate.release();
  }
});

for (const role of ["member", "guest"] as const) {
  test(`Logo ${role} sees saved brand without mutation or File inventory access`, async ({
    page,
  }) => {
    const api = await installLogoApi(page);
    api.role = role;
    api.workspace.logo_file_id = oldLogoId;
    api.workspace.theme = "stockroom";
    api.files.set(oldLogoId, logoFile(oldLogoId));
    await page.goto("/manage?view=organization");
    await expect(
      header(page).getByRole("img", {
        name: "Harbor Services logo",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Organization logo", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Logo files", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Remove logo", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("note", { name: "Organization data", exact: true }),
    ).toContainText("Only an administrator can change these settings.");
    // Profile fields are read-only, and a guest reply carries no contacts.
    await expect(field(page, "Legal name")).toHaveValue("Harbor Services Ltd");
    await expect(field(page, "Legal name")).toBeDisabled();
    await expect(field(page, "Description")).toBeDisabled();
    if (role === "guest") {
      await expect(field(page, "Contact email")).toHaveCount(0);
      await expect(field(page, "Contact phone")).toHaveCount(0);
      await expect(field(page, "Postal address")).toHaveCount(0);
    } else {
      await expect(field(page, "Contact email")).toHaveValue(
        "contact@example.test",
      );
      await expect(field(page, "Contact email")).toBeDisabled();
    }
    // The saved look shows; a pointer click on another look changes nothing.
    await expect(radio(page, "Stockroom")).toBeChecked();
    await expect(radio(page, "Whiteboard")).toBeDisabled();
    const whiteboard = (await look(page)
      .locator("label")
      .filter({ hasText: "Whiteboard" })
      .boundingBox())!;
    await page.mouse.click(
      whiteboard.x + whiteboard.width / 2,
      whiteboard.y + whiteboard.height / 2,
    );
    await expect(radio(page, "Stockroom")).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    await expect(save(page)).toHaveCount(0);
    expect(api.lists).toEqual([]);
    expect(api.writes).toEqual([]);
  });
}

// The size and header faults are rows of
// isolated/shell/workspace-logo-api.spec.ts.
test("Logo invalid inline media type falls back to saved mark and explicitly retries", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  api.workspace.logo_file_id = oldLogoId;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  api.onLogo = (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
      body: png,
    });
  await page.goto("/manage?view=organization");
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services mark: HS",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toHaveCount(0);
  api.onLogo = null;
  await header(page)
    .getByRole("button", { name: "Retry logo", exact: true })
    .click();
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
});

test("Logo bytes from a superseded binding cannot replace the current saved brand", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const api = await installLogoApi(page);
  api.workspace.logo_file_id = oldLogoId;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  const gate = heldResponse();
  const reading = heldResponse();
  api.onLogo = async (route) => {
    reading.release();
    await gate.released;
    await route
      .fulfill({
        contentType: "image/png",
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
        body: png,
      })
      .catch(() => undefined);
  };
  try {
    await page.goto("/manage?view=organization");
    await reading.released;
    const current = "77777777-7777-4777-8777-777777777777";
    api.files.set(current, logoFile(current));
    api.workspace.logo_file_id = current;
    api.workspace.display_name = "Current binding";
    api.workspace.revision += 1;
    api.onLogo = null;
    await sendOpenViewEvent(page, "invalidate", {
      entity: "workspace_profiles",
    });
    await expect(
      header(page).getByRole("img", {
        name: "Current binding logo",
        exact: true,
      }),
    ).toBeVisible();
    gate.release();
    await expect(
      header(page).getByRole("img", {
        name: "Harbor Services logo",
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    gate.release();
  }
});

test("Logo pending upload blocks duplicate Save and departure without publishing early", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  const gate = heldResponse();
  const uploading = heldResponse();
  api.onUpload = async (route) => {
    uploading.release();
    await gate.released;
    const id = new URL(route.request().url()).pathname.split("/")[3];
    const file = logoFile(id);
    api.files.set(id, file);
    await route.fulfill({ json: file }).catch(() => undefined);
  };
  try {
    await page.goto("/manage?view=organization");
    await pick(page);
    await save(page).click();
    await uploading.released;
    await expect(save(page)).toBeDisabled();
    await header(page)
      .getByRole("link", { name: "Harbor Services workspace", exact: true })
      .click();
    await expect(
      page.getByText("Finish the current change before leaving this page.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/manage\?view=organization$/);
    expect(patches(api)).toEqual([]);
    gate.release();
    await expect(
      page.getByText("Organization settings saved.", { exact: true }),
    ).toBeVisible();
    expect(api.writes.filter(({ path }) => path === "/files")).toHaveLength(1);
    expect(patches(api)).toHaveLength(1);
  } finally {
    gate.release();
  }
});

test("Logo delayed admitted B receipt cannot replace newer C brand, theme or revision", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const api = await installLogoApi(page);
  api.workspace.logo_file_id = oldLogoId;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  const admitted = heldResponse();
  const release = heldResponse();
  api.onPatch = async (route, receipt) => {
    admitted.release();
    await release.released;
    await route.fulfill({ json: receipt });
  };
  try {
    await page.goto("/manage?view=organization");
    await pick(page);
    await page
      .getByLabel("Organization name", { exact: true })
      .fill("Admitted B");
    await save(page).click();
    await admitted.released;
    const current = "88888888-8888-4888-8888-888888888888";
    api.files.set(current, logoFile(current));
    api.workspace = {
      ...api.workspace,
      display_name: "Newer C",
      mark: "CURRENT",
      theme: "stockroom",
      logo_file_id: current,
      revision: 6,
    };
    await sendOpenViewEvent(page, "invalidate", {
      entity: "workspace_profiles",
    });
    await expect(
      header(page).getByRole("img", { name: "Newer C logo", exact: true }),
    ).toBeVisible();
    release.release();
    await expect(
      page.getByLabel("Organization name", { exact: true }),
    ).toHaveValue("Newer C");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "stockroom",
    );
    await expect(save(page)).toBeDisabled();
    expect(patches(api)).toHaveLength(1);
    api.onPatch = null;
    await page
      .getByLabel("Description", { exact: true })
      .fill("Explicit next change");
    await save(page).click();
    await expect(
      page.getByText("Organization settings saved.", { exact: true }),
    ).toBeVisible();
    expect(patches(api)).toHaveLength(2);
    expect(patches(api)[1].body?.revision).toBe(6);
  } finally {
    release.release();
  }
});

for (const status of [503, 403]) {
  test(`Logo committed ACK with ${status} readback never becomes an unsaved message or automatic retry`, async ({
    page,
  }) => {
    const api = await installLogoApi(page);
    api.onPatch = (route, receipt) => {
      api.readStatus = status;
      return route.fulfill({ json: receipt });
    };
    await page.goto("/manage?view=organization");
    await pick(page);
    await page
      .getByLabel("Description", { exact: true })
      .fill("Committed description");
    await save(page).click();
    await expect(
      page.getByText(
        "Settings saved. Current organization settings could not be loaded. Retry before making another change.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("The settings could not be saved. Try again.", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(save(page)).toBeDisabled();
    expect(patches(api)).toHaveLength(1);
    api.readStatus = 200;
    api.onPatch = null;
    await page
      .getByRole("button", { name: "Retry organization settings", exact: true })
      .click();
    await expect(
      header(page).getByRole("img", {
        name: "Harbor Services logo",
        exact: true,
      }),
    ).toBeVisible();
    expect(patches(api)).toHaveLength(1);
    expect(api.writes.filter(({ path }) => path === "/files")).toHaveLength(1);
  });
}

test("Logo saved brand updates through the existing SSE stream and a client-side revisit uses cached bytes", async ({
  page,
}) => {
  await installOpenViewEventSource(page);
  const api = await installLogoApi(page);
  await page.goto("/manage?view=organization");
  await expect(
    header(page).getByRole("img", {
      name: "Harbor Services mark: HS",
      exact: true,
    }),
  ).toBeVisible();
  api.workspace.logo_file_id = oldLogoId;
  api.workspace.display_name = "Server changed brand";
  api.workspace.revision += 1;
  api.files.set(oldLogoId, logoFile(oldLogoId));
  await sendOpenViewEvent(page, "invalidate", { entity: "workspace_profiles" });
  await expect(
    header(page).getByRole("img", {
      name: "Server changed brand logo",
      exact: true,
    }),
  ).toBeVisible();
  const reads = api.logoReads;
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await page.getByRole("link", { name: "Organization", exact: true }).click();
  await expect(
    header(page).getByRole("img", {
      name: "Server changed brand logo",
      exact: true,
    }),
  ).toBeVisible();
  expect(api.logoReads).toBe(reads);
});

test("Logo privacy curtain conceals a selected preview and restores only the same account draft", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  await page.addInitScript(() =>
    localStorage.setItem("openslate-org-theme", "slate"),
  );
  await page.goto("/manage?view=organization");
  // One session check conceals three drafts: a contact, a look and a logo.
  await field(page, "Contact email").fill("retained@example.com");
  await expect(radio(page, "Stockroom")).toBeEnabled();
  await look(page).locator("label").filter({ hasText: "Stockroom" }).click();
  await pick(page);
  const gate = heldResponse();
  const requested = heldResponse();
  api.onSession = async (route) => {
    requested.release();
    await gate.released;
    await route.fulfill({
      json: { authenticated: true, user_id: api.actor, setup_required: false },
    });
  };
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await requested.released;
  const curtain = page.getByRole("dialog", {
    name: "Session verification",
    exact: true,
  });
  await expect(curtain).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Harbor Services logo", exact: true }),
  ).toHaveCount(0);
  await expect(field(page, "Contact email")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect(
    await page.evaluate(() => localStorage.getItem("openslate-org-theme")),
  ).toBe("slate");
  gate.release();
  await expect(curtain).toBeHidden();
  await expect(
    preview(page).getByRole("img", {
      name: "Harbor Services logo",
      exact: true,
    }),
  ).toBeVisible();
  await expect(field(page, "Contact email")).toHaveValue(
    "retained@example.com",
  );
  await expect(radio(page, "Stockroom")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "stockroom");
  expect(api.writes).toEqual([]);
});

test("Logo late upload cannot commit settings after the verified account changes", async ({
  page,
}) => {
  const api = await installLogoApi(page);
  const gate = heldResponse();
  const uploaded = heldResponse();
  api.onUpload = async (route) => {
    uploaded.release();
    await gate.released;
    const id = new URL(route.request().url()).pathname.split("/")[3];
    await route.fulfill({ json: logoFile(id) }).catch(() => undefined);
  };
  await page.goto("/manage?view=organization");
  await pick(page);
  await save(page).click();
  await uploaded.released;
  api.actor = "66666666-6666-4666-8666-666666666666";
  api.workspace.display_name = "Second verified account";
  await page.evaluate(() => window.dispatchEvent(new FocusEvent("focus")));
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("Second verified account");
  gate.release();
  await expect(
    preview(page).getByRole("img", {
      name: "Second verified account mark: HS",
      exact: true,
    }),
  ).toBeVisible();
  expect(patches(api)).toEqual([]);
  await expect(save(page)).toBeDisabled();
});
