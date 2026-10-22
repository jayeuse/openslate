import { expect, test, expectNoHorizontalScroll } from "./helpers/test";
import {
  installCommsSearchApi,
  searchIdentity,
} from "./helpers/comms-search-api";

async function openSearch(page: import("@playwright/test").Page) {
  await page
    .getByRole("textbox", { name: "Search messages", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Search messages",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("search sends current/all scopes and filter chips to HTTP and safely highlights code points", async ({
  page,
}) => {
  const server = await installCommsSearchApi(page);
  const directories: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/users")
      directories.push(request.url());
  });
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    const dialog = await openSearch(page);
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("comet");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => server.searchRequests.length).toBe(1);
    expect(server.searchRequests[0].searchParams.get("in")).toBe(server.room);
    const result = dialog.getByRole("button", {
      name: "Open message from Search owner in Search dispatch",
    });
    await expect(result).toContainText("😀 İ comet <b>plain</b>");
    await expect(result.locator("mark")).toHaveText("comet");
    await expect(result.locator("b")).toHaveCount(0);
    for (const chip of ["Who", "What", "When", "Where", "Has", "Is"])
      await expect(
        dialog.getByRole("button", { name: new RegExp(`^${chip}( filter|:)`) }),
      ).toBeVisible();
    await dialog.getByRole("button", { name: /^Where( filter|:)/ }).click();
    await dialog.getByLabel("Where", { exact: true }).selectOption("all");
    await dialog.getByRole("button", { name: /^Who( filter|:)/ }).click();
    await dialog
      .getByLabel("Who", { exact: true })
      .selectOption(server.owner.user_id);
    await dialog.getByRole("button", { name: /^When( filter|:)/ }).click();
    await dialog.getByLabel("After", { exact: true }).fill("2026-10-20");
    await dialog.getByLabel("Before", { exact: true }).fill("2026-10-18");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      /After.*before.*Before/,
    );
    expect(server.searchRequests).toHaveLength(1);
    await dialog.getByLabel("After", { exact: true }).fill("2026-10-18");
    await dialog.getByLabel("Before", { exact: true }).fill("2026-10-20");
    await dialog.getByLabel("On", { exact: true }).fill("2026-10-19");
    await dialog.getByRole("button", { name: /^Has( filter|:)/ }).click();
    await dialog.getByLabel("Has", { exact: true }).selectOption("file");
    await dialog.getByRole("button", { name: /^Is( filter|:)/ }).click();
    await dialog.getByLabel("Is", { exact: true }).selectOption("thread");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => server.searchRequests.length).toBe(2);
    expect(
      Object.fromEntries(server.searchRequests[1].searchParams),
    ).toMatchObject({
      q: "comet",
      from: server.owner.user_id,
      after: "2026-10-18",
      before: "2026-10-20",
      on: "2026-10-19",
      has: "file",
      is: "thread",
    });
    expect(server.searchRequests[1].searchParams.has("in")).toBe(false);
    expect(directories).toEqual([]);
  } finally {
    server.close();
  }
});

test("search opens another conversation in place, preserves the draft and clears its target highlight", async ({
  page,
}) => {
  await page.clock.install();
  const server = await installCommsSearchApi(page);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/comms/conversations/${server.otherRoom}/messages?*`,
    async (route) => {
      enter();
      await held;
      await route.fallback();
    },
  );
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Keep this conversation draft");
    await page.evaluate(() => {
      document.documentElement.dataset.searchDocument = "same";
    });
    const dialog = await openSearch(page);
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("needle");
    await dialog.getByRole("button", { name: /^Where( filter|:)/ }).click();
    await dialog.getByLabel("Where", { exact: true }).selectOption("all");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await dialog
      .getByRole("button", {
        name: "Open message from Search owner in Search archive",
      })
      .click();
    await entered;
    await page.clock.runFor(3000);
    release();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get("conversation") === server.otherRoom &&
        url.searchParams.get("message") === server.otherHit.message_id,
    );
    const target = page
      .getByRole("article")
      .filter({ hasText: "Archive needle target" });
    await expect(target).toBeVisible();
    await expect(target).toHaveAttribute("data-highlighted", "true");
    await page.clock.runFor(3000);
    await expect(target).not.toHaveAttribute("data-highlighted", "true");
    expect(
      await page.evaluate(
        () => document.documentElement.dataset.searchDocument,
      ),
    ).toBe("same");
    await page
      .getByRole("button", { name: "Search dispatch", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Keep this conversation draft");
  } finally {
    release();
    server.close();
  }
});

test("search pages remain server-bounded and changing filters resets the page", async ({
  page,
}) => {
  const server = await installCommsSearchApi(page);
  server.setSearchReply((url) => {
    const offset = Number(url.searchParams.get("offset"));
    const count = offset === 0 ? 25 : 1;
    return {
      total: 26,
      items: Array.from({ length: count }, (_, index) => ({
        ...server.primaryHit,
        message_id: `7c000000-0000-4000-8000-${String(offset + index + 1).padStart(12, "0")}`,
        seq: offset + index + 1,
        excerpt: `Server result ${offset + index + 1}`,
        matches: [],
      })),
    };
  });
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    const dialog = await openSearch(page);
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: /Open message from/ }),
    ).toHaveCount(25);
    await dialog
      .getByRole("button", { name: "Next results", exact: true })
      .click();
    await expect(
      dialog.getByText("Server result 26", { exact: true }),
    ).toBeVisible();
    expect(server.searchRequests.at(-1)?.searchParams.get("offset")).toBe("25");
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("changed");
    await expect(
      dialog.getByText("Server result 26", { exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect
      .poll(() => server.searchRequests.at(-1)?.searchParams.get("offset"))
      .toBe("0");
  } finally {
    server.close();
  }
});

test("search opens a reply through existing message/thread navigation", async ({
  page,
}) => {
  const server = await installCommsSearchApi(page);
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    const dialog = await openSearch(page);
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("thread");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await dialog
      .getByRole("button", {
        name: "Open message from Search owner in Search dispatch",
      })
      .click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("message") === server.replyHit.message_id,
    );
    const thread = page.getByRole("region", {
      name: "Thread conversation",
    });
    await expect(thread).toBeVisible();
    await expect(
      thread.getByText("Thread needle reply", { exact: true }),
    ).toBeVisible();
  } finally {
    server.close();
  }
});

test("search refusal hides cached excerpts and distinguishes retry from an empty result", async ({
  page,
}) => {
  const server = await installCommsSearchApi(page);
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    const dialog = await openSearch(page);
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("comet");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: /Open message from/ }),
    ).toHaveCount(1);
    server.setSearchReply(() => ({ status: 403 }));
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Search could not be loaded",
    );
    await expect(
      dialog.getByRole("button", { name: /Open message from/ }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText("PRIVATE FAILURE TEXT MUST NOT BE SHOWN"),
    ).toHaveCount(0);
    await expect(
      dialog.getByText("No messages match these filters."),
    ).toHaveCount(0);
    server.setSearchReply(() => ({ items: [] }));
    await dialog
      .getByRole("button", { name: "Retry search", exact: true })
      .click();
    await expect(
      dialog.getByText("No messages match these filters."),
    ).toBeVisible();
  } finally {
    server.close();
  }
});

test("a late search response cannot replace newer criteria", async ({
  page,
}) => {
  const server = await installCommsSearchApi(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.setSearchReply(async (url) => {
    if (url.searchParams.get("q") === "slow") {
      await held;
      return {
        items: [
          { ...server.primaryHit, excerpt: "Old query canary", matches: [] },
        ],
      };
    }
    return {
      items: [
        {
          ...server.primaryHit,
          excerpt:
            url.searchParams.get("q") === "needle"
              ? "Needle query result"
              : "Comet query result",
          matches: [],
        },
      ],
    };
  });
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    const dialog = await openSearch(page);
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("slow");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => server.searchRequests.length).toBe(1);
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("comet");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByText("Comet query result", { exact: true }),
    ).toBeVisible();
    release();
    await expect(dialog.getByText("Old query canary")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page
      .getByRole("textbox", { name: "Search messages", exact: true })
      .fill("needle");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "What", exact: true }),
    ).toHaveValue("needle");
    await expect(
      dialog.getByRole("button", { name: /Open message from/ }),
    ).toHaveCount(0);
    expect(server.searchRequests).toHaveLength(2);
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByText("Needle query result", { exact: true }),
    ).toBeVisible();
    expect(server.searchRequests.at(-1)?.searchParams.get("q")).toBe("needle");
  } finally {
    release();
    server.close();
  }
});

for (const boundary of ["account", "organization"] as const)
  test(`search state and delayed bytes do not cross the ${boundary} boundary`, async ({
    page,
  }) => {
    const identity = await searchIdentity(page);
    const old = await installCommsSearchApi(page, {
      prefix: "Old identity canary",
    });
    const nextUser =
      boundary === "account"
        ? "7a000000-0000-4000-8000-000000000003"
        : identity.state.userId;
    const nextOrg =
      boundary === "organization"
        ? identity.other.org_id
        : identity.primary.org_id;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    old.setSearchReply(async () => {
      await waiting;
      return { items: [old.primaryHit] };
    });
    let next: Awaited<ReturnType<typeof installCommsSearchApi>> | undefined;
    try {
      await page.goto(`/comms?conversation=${old.room}`);
      const dialog = await openSearch(page);
      await dialog
        .getByRole("textbox", { name: "What", exact: true })
        .fill("old private query");
      await dialog.getByRole("button", { name: "Search", exact: true }).click();
      await expect.poll(() => old.searchRequests.length).toBe(1);
      next = await installCommsSearchApi(page, {
        userId: nextUser,
        orgId: nextOrg,
        prefix: "New identity content",
        workspaceEvents: false,
      });
      if (boundary === "account") {
        identity.state.userId = nextUser;
        await page.evaluate(() =>
          window.dispatchEvent(new FocusEvent("focus")),
        );
      } else {
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: /^Organization:/ }).click();
        await page.getByRole("menuitem", { name: /^Search partner/ }).click();
      }
      await expect(dialog).toBeHidden();
      release();
      if (boundary === "organization")
        await page
          .getByRole("link", { name: "OpenComms", exact: true })
          .click();
      await expect(
        page.getByRole("textbox", { name: "Search messages", exact: true }),
      ).toHaveValue("");
      const fresh = await openSearch(page);
      await expect(
        fresh.getByRole("textbox", { name: "What", exact: true }),
      ).toHaveValue("");
      await expect(fresh.getByText("Old identity canary")).toHaveCount(0);
      await expect(fresh.getByText("old private query")).toHaveCount(0);
    } finally {
      release();
      old.close();
      next?.close();
    }
  });

test("search keeps shortcut focus, phone Details and readable light/dark results", async ({
  page,
}, info) => {
  const server = await installCommsSearchApi(page);
  try {
    await page.goto(`/comms?conversation=${server.room}`);
    // Focus is the existing shortcut contract; no second shortcut listener is introduced.
    const entry = page.getByRole("textbox", {
      name: "Search messages",
      exact: true,
    });
    await entry.focus();
    await expect(entry).toBeFocused();
    await entry.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Search messages",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("textbox", { name: "What", exact: true }),
    ).toBeFocused();
    await dialog
      .getByRole("textbox", { name: "What", exact: true })
      .fill("comet");
    await dialog.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: /Open message from/ }),
    ).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const dark of [false, true]) {
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          dark,
        );
        await expectNoHorizontalScroll(page);
        if (process.env.OPENSLATE_S30_VISUAL === "1")
          await dialog.screenshot({
            path: info.outputPath(
              `search-${width}-${dark ? "dark" : "light"}.png`,
            ),
          });
      }
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Details", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Search messages", exact: true }),
    ).toBeVisible();
  } finally {
    server.close();
  }
});
