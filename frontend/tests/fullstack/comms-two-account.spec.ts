import { expect } from "@playwright/test";
import {
  api,
  articleWith,
  commsTest,
  focusRoom,
  messageAction,
  object,
  proofRecorder,
  received,
  rootArticle,
  send,
  showRoom,
  type Account,
} from "./comms-fixture";

// Real two-account functional journey: no routes, mock transports, seeded messages,
// saved cookie state or auth trace artifacts. Per-step proof goes to a stable results
// file. Bounds that need long real-time waits live in comms-measurements.spec.ts.
const test = commsTest({
  slug: "member",
  member: "S32 Member",
  room: "s32-two-account",
  lobby: "s32-lobby",
  isolated: "s32-isolated",
});
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  // A missing control fails its own step instead of the whole journey's budget.
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
});

test.setTimeout(300_000);
test("real invited accounts complete the Comms journey without crossing organization or session", async ({
  comms,
}) => {
  const {
    fixture: owned,
    admin,
    member,
    isolated,
    room,
    lobby,
    isolatedRoom,
  } = comms;
  const origin = owned.baseURL;
  const { step, finish } = proofRecorder(owned.runId, "journey.json");
  const reset = (account: Account) =>
    showRoom(account, "s32-two-account", room);
  const reload = (account: Account) =>
    focusRoom(account, origin, "s32-two-account", room);
  const sends = { [admin.id]: [] as number[], [member.id]: [] as number[] };
  let root = { id: "", seq: 0 };
  const rootBody = `Owned administrator message ${owned.runId}`;
  let scheduled = { body: "", at: 0 };

  await step(
    "sessions are bound to their own account and organization",
    async () => {
      for (const account of [admin, member, isolated]) {
        const session = await api(
          account.page,
          account.orgId,
          "GET",
          "/api/auth/session",
        );
        expect(session.status).toBe(200);
        const state = object(session.payload);
        expect(state.authenticated).toBe(true);
        expect(state.user_id).toBe(account.id);
        expect(state.organization_id).toBe(account.orgId);
        expect(
          await account.page.evaluate(() =>
            /(?:^|;\s*)openslate_(?:access|refresh)=/u.test(document.cookie),
          ),
        ).toBe(false);
        // The shell event stream (one per account and organization) must open.
        try {
          await expect.poll(() => account.wire.sse).toBe(true);
        } catch {
          throw new Error(
            `${account.name}${account === isolated ? " (second org)" : ""} event stream not opened; statuses=[${account.wire.sseStatuses.join(",")}]`,
          );
        }
      }
      return Object.fromEntries(
        [admin, member, isolated].map((account) => [
          account.name + (account === isolated ? " (second org)" : ""),
          { sse: account.wire.sse, statuses: account.wire.sseStatuses },
        ]),
      );
    },
  );

  await step(
    "send: member receives the administrator's named message live",
    async () => {
      const started = Date.now();
      const sent = await send(admin, room, rootBody);
      await received(member, room, sent.seq, admin.name, rootBody);
      root = { id: sent.id, seq: sent.seq };
      sends[admin.id]!.push(started);
      return { seq: sent.seq, sendToVisibleMs: Date.now() - started };
    },
  );

  await step(
    "quote: member's reply quotes the root and reaches the administrator",
    async () => {
      await reset(admin);
      await reset(member);
      const incoming = articleWith(member, rootBody);
      await messageAction(incoming, member.page, "Reply");
      const replyBody = `Owned member reply ${owned.runId}`;
      const reply = await send(member, room, replyBody);
      sends[member.id]!.push(Date.now());
      expect(reply.replyTo).toBe(root.id);
      const article = await received(
        admin,
        room,
        reply.seq,
        member.name,
        replyBody,
      );
      await expect(article).toContainText(`${admin.name}: ${rootBody}`);
      const stored = await api(
        admin.page,
        admin.orgId,
        "GET",
        `/api/comms/conversations/${room}/messages/${reply.id}`,
      );
      expect(stored.status).toBe(200);
      expect(object(stored.payload).author_id).toBe(member.id);
      expect(object(stored.payload).reply_to_id).toBe(root.id);
      return { seq: reply.seq };
    },
  );

  await step(
    "react: administrator sees the member's reaction live",
    async () => {
      await reset(admin);
      await reset(member);
      const article = rootArticle(member, root.seq);
      await article
        .getByRole("button", { name: /^Message actions: /u })
        .click();
      await member.page
        .getByRole("menuitem", { name: "Add reaction", exact: true })
        .hover();
      const started = Date.now();
      await member.page
        .getByRole("menuitem", { name: "React with 👍", exact: true })
        .click();
      await expect(
        rootArticle(admin, root.seq).getByRole("button", {
          name: `👍 1: ${member.name}`,
        }),
      ).toBeVisible();
      return { reactionToVisibleMs: Date.now() - started };
    },
  );

  await step(
    "counts: sidebar unread and mention counts agree with bootstrap",
    async () => {
      await focusRoom(member, origin, "s32-lobby", lobby);
      await reset(admin);
      const plain = await send(admin, room, `Owned unread one ${owned.runId}`);
      sends[admin.id]!.push(Date.now());
      const composer = admin.page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      // A mention token ends at a space, so type a single word of the name.
      await composer.fill("@Member");
      await admin.page
        .getByRole("listbox", { name: "Mention members" })
        .getByRole("option", { name: member.name, exact: true })
        .click();
      await composer.press("End");
      await composer.pressSequentially(` mention ${owned.runId}`);
      const [response] = await Promise.all([
        admin.page.waitForResponse(
          (reply) =>
            new URL(reply.url()).pathname ===
              `/api/comms/conversations/${room}/messages` &&
            reply.request().method() === "POST",
        ),
        admin.page
          .getByRole("button", { name: "Send message", exact: true })
          .click(),
      ]);
      sends[admin.id]!.push(Date.now());
      expect(response.status()).toBe(201);
      const mention = object(await response.json());
      const row = member.page.getByRole("button", {
        name: /^s32-two-account, 2 unread, 1 mention(,|$)/u,
      });
      await expect(row).toBeVisible();
      const boot = await api(
        member.page,
        member.orgId,
        "GET",
        "/api/comms/bootstrap",
      );
      expect(boot.status).toBe(200);
      const summaries = object(boot.payload).conversations;
      expect(Array.isArray(summaries)).toBe(true);
      const summary = (summaries as unknown[])
        .map(object)
        .find((entry) => object(entry.conversation).id === room);
      expect(summary?.unread_count).toBe(2);
      expect(summary?.mention_count).toBe(1);
      await row.click();
      await expect(
        member.page.getByRole("button", { name: /^s32-two-account$/u }),
      ).toBeVisible();
      return {
        plainSeq: plain.seq,
        mentionSeq: mention.seq,
        mentionUserIds: mention.mention_user_ids,
        bootstrap: {
          unread: summary?.unread_count,
          mentions: summary?.mention_count,
        },
      };
    },
  );

  await step(
    "schedule: administrator schedules a message for the next minute",
    async () => {
      await reset(admin);
      const target = await admin.page.evaluate(() => {
        const at = new Date(Date.now() + 75_000);
        at.setSeconds(0, 0);
        at.setMinutes(at.getMinutes() + 1);
        const pad = (value: number) => String(value).padStart(2, "0");
        return {
          local: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
          epoch: at.getTime(),
        };
      });
      scheduled = {
        body: `Owned scheduled message ${owned.runId}`,
        at: target.epoch,
      };
      const composer = admin.page.getByRole("textbox", {
        name: "Message",
        exact: true,
      });
      await composer.fill(scheduled.body);
      await admin.page
        .getByRole("button", { name: "Schedule send", exact: true })
        .click();
      await admin.page
        .getByLabel("Send at (local time)", { exact: true })
        .fill(target.local);
      const [response] = await Promise.all([
        admin.page.waitForResponse(
          (reply) =>
            reply.request().method() === "POST" &&
            new URL(reply.url()).pathname === "/api/comms/scheduled-messages",
        ),
        admin.page
          .getByRole("button", { name: "Schedule message", exact: true })
          .click(),
      ]);
      expect(response.status()).toBe(201);
      await expect(composer).toHaveValue("");
      return { sendAt: new Date(target.epoch).toISOString() };
    },
  );

  await step("edit and delete reach the member live", async () => {
    await reset(admin);
    await reset(member);
    const body = `Owned edit target ${owned.runId}`;
    const sent = await send(admin, room, body);
    sends[admin.id]!.push(Date.now());
    await received(member, room, sent.seq, admin.name, body);
    await messageAction(articleWith(admin, body), admin.page, "Edit message");
    const edited = `Owned edited text ${owned.runId}`;
    await admin.page
      .getByRole("textbox", { name: "Edit message", exact: true })
      .fill(edited);
    const editStarted = Date.now();
    await admin.page
      .getByRole("button", { name: "Save message", exact: true })
      .click();
    const editedArticle = articleWith(member, edited);
    await expect(editedArticle).toBeVisible();
    await expect(
      editedArticle.getByText("edited", { exact: true }),
    ).toBeVisible();
    const editMs = Date.now() - editStarted;
    const deleteStarted = Date.now();
    await messageAction(
      articleWith(admin, edited),
      admin.page,
      "Delete message",
    );
    // Delete commits at once; Undo is offered afterwards as a restore.
    await expect(articleWith(member, edited)).toHaveCount(0);
    return {
      seq: sent.seq,
      editToVisibleMs: editMs,
      deleteToHiddenMs: Date.now() - deleteStarted,
    };
  });

  await step(
    "upload: member receives the administrator's attachment",
    async () => {
      await reload(admin);
      await reset(member);
      const name = `s32-proof-${owned.runId.slice(0, 8)}.png`;
      await admin.page
        .getByLabel("Upload files", { exact: true })
        .setInputFiles({
          name,
          mimeType: "image/png",
          buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
            "base64",
          ),
        });
      try {
        await expect(
          admin.page.getByRole("button", {
            name: `Remove ${name}`,
            exact: true,
          }),
        ).toBeVisible();
      } catch {
        const alerts = await admin.page
          .getByRole("form", { name: "Message composer" })
          .getByRole("alert")
          .allTextContents();
        throw new Error(
          `attachment not ready; composer alerts: ${alerts.join(" | ").slice(0, 200)}`,
        );
      }
      const body = `Owned attachment ${owned.runId}`;
      const sent = await send(admin, room, body);
      sends[admin.id]!.push(Date.now());
      const article = await received(member, room, sent.seq, admin.name, body);
      await expect(article).toContainText(name);
      return { seq: sent.seq };
    },
  );

  await step("moderator remove and restore reach the member", async () => {
    await reset(admin);
    await reset(member);
    const body = `Owned moderation target ${owned.runId}`;
    const sent = await send(member, room, body);
    sends[member.id]!.push(Date.now());
    await received(admin, room, sent.seq, member.name, body);
    await messageAction(articleWith(admin, body), admin.page, "Report message");
    const reason = `Owned report ${owned.runId}`;
    await admin.page.getByLabel("Reason", { exact: true }).fill(reason);
    const [filed] = await Promise.all([
      admin.page.waitForResponse(
        (reply) =>
          reply.request().method() === "POST" &&
          new URL(reply.url()).pathname ===
            `/api/comms/conversations/${room}/messages/${sent.id}/reports`,
      ),
      admin.page
        .getByRole("button", { name: "Submit report", exact: true })
        .click(),
    ]);
    expect(filed.status()).toBe(204);
    await reload(admin);
    await admin.page
      .getByRole("button", { name: "OpenComms menu", exact: true })
      .first()
      .click();
    await admin.page.getByRole("menuitem", { name: /^Admin tools/u }).click();
    await admin.page
      .getByRole("menuitem", { name: /^Moderation(?: |$)/u })
      .click();
    const tool = admin.page.getByRole("region", {
      name: "Moderation",
      exact: true,
    });
    await expect(tool).toBeVisible();
    const removeStarted = Date.now();
    const card = tool.getByRole("article").filter({ hasText: reason });
    try {
      await expect(card).toBeVisible();
    } catch {
      throw new Error(
        `report card missing; tool shows: ${((await tool.textContent()) ?? "").slice(0, 300)}`,
      );
    }
    await card
      .getByRole("button", { name: "Remove message recoverably", exact: true })
      .click();
    await expect(articleWith(member, body)).toHaveCount(0);
    const removeMs = Date.now() - removeStarted;
    const recoverable = tool.locator('[data-slot="card"]').filter({
      has: admin.page.getByRole("button", {
        name: "Restore message",
        exact: true,
      }),
    });
    await expect(
      recoverable
        .locator('[data-slot="card-title"]')
        .filter({ hasText: member.name }),
    ).toBeVisible();
    const restoreTitles = await recoverable
      .locator('[data-slot="card-title"]')
      .allTextContents();
    const restoreIndex = restoreTitles.indexOf(member.name);
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    const restoreStarted = Date.now();
    const [restored] = await Promise.all([
      admin.page.waitForResponse(
        (reply) =>
          reply.request().method() === "POST" &&
          new URL(reply.url()).pathname.endsWith(
            `/messages/${sent.id}/restoration`,
          ),
      ),
      // Recoverable messages also list the administrator's own deleted message: pick
      // the recoverable card whose title names the member (cards follow the list order).
      tool
        .getByRole("button", { name: "Restore message", exact: true })
        .nth(restoreIndex)
        .click(),
    ]);
    const restoreStatus = restored.status();
    try {
      await expect(articleWith(member, body)).toBeVisible();
    } catch {
      // Separate a missing live update from a failed restore: does a fresh load show it?
      await reload(member);
      const afterReload = await articleWith(member, body).count();
      throw new Error(
        `restored message not shown live to the member within 10 s; restore HTTP ${restoreStatus}; visible after reload: ${afterReload > 0}`,
      );
    }
    return {
      seq: sent.seq,
      removeToHiddenMs: removeMs,
      restoreToVisibleMs: Date.now() - restoreStarted,
    };
  });

  await step(
    "thread: administrator's thread reply is readable by the member",
    async () => {
      await reset(admin);
      await messageAction(
        rootArticle(admin, root.seq),
        admin.page,
        "Create thread",
      );
      const thread = admin.page.getByRole("region", {
        name: "Thread conversation",
        exact: true,
      });
      const reply = thread.getByRole("textbox", {
        name: "Thread reply",
        exact: true,
      });
      const body = `Owned thread reply ${owned.runId}`;
      await reply.fill(body);
      await thread
        .getByRole("button", { name: "Send reply", exact: true })
        .click();
      await expect(reply).toHaveValue("");
      await expect(
        thread.getByRole("article").filter({ hasText: body }),
      ).toHaveCount(1);
      sends[admin.id]!.push(Date.now());
      const listed = await api(
        member.page,
        member.orgId,
        "GET",
        `/api/comms/conversations/${room}/threads/${root.id}/replies?limit=50`,
      );
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.payload)).toContain(body);
    },
  );

  await step("presence: administrator sees the member online", async () => {
    await admin.page.goto(`${origin}/comms?conversation=${room}&panel=members`);
    await expect(
      admin.page
        .getByRole("region", { name: "Members with access", exact: true })
        .getByRole("region", { name: "Online members", exact: true }),
    ).toContainText(member.name);
  });

  await step(
    "second organization never sees the first organization's events",
    async () => {
      await focusRoom(isolated, origin, "s32-isolated", isolatedRoom);
      const canary = await send(
        isolated,
        isolatedRoom,
        "Owned second-organization positive control",
      );
      await received(
        isolated,
        isolatedRoom,
        canary.seq,
        admin.name,
        "Owned second-organization positive control",
      );
      for (const account of [admin, member, isolated])
        expect(account.wire.foreignTopic).toBe(false);
      expect(
        isolated.wire.messages.some((item) => item.topic.includes(room)),
      ).toBe(false);
      await expect(
        isolated.page.getByRole("article").filter({ hasText: rootBody }),
      ).toHaveCount(0);
      // A person outside the second organization is refused; its own member finds nothing.
      const denied = await api(
        member.page,
        isolated.orgId,
        "GET",
        `/api/comms/conversations/${room}/messages/${root.id}`,
      );
      expect(denied.status).toBe(403);
      const hidden = await api(
        isolated.page,
        isolated.orgId,
        "GET",
        `/api/comms/conversations/${room}/messages/${root.id}`,
      );
      expect(hidden.status).toBe(404);
      return {
        nonMemberStatus: denied.status,
        otherOrgMemberStatus: hidden.status,
        isolatedFrames: isolated.wire.messages.length,
      };
    },
  );

  await step(
    "schedule: the scheduled message is delivered to the member",
    async () => {
      expect(scheduled.at).toBeGreaterThan(0);
      await reset(member);
      await expect(articleWith(member, scheduled.body)).toBeVisible({
        timeout: Math.max(10_000, scheduled.at - Date.now() + 60_000),
      });
      return { deliveredAfterSendAtMs: Date.now() - scheduled.at };
    },
  );

  await step("removed member: content is refused at once", async () => {
    await reset(admin);
    await reset(member);
    const current = await api(
      admin.page,
      admin.orgId,
      "GET",
      `/api/comms/conversations/${room}`,
    );
    // Conversation ETag: quoted SHA-256 (conversations/service.py).
    expect(current.etag).toMatch(/^"[0-9a-f]{64}"$/u);
    const removed = await api(
      admin.page,
      admin.orgId,
      "DELETE",
      `/api/comms/conversations/${room}/members/${member.id}`,
      undefined,
      { "If-Match": current.etag! },
    );
    expect(removed.status).toBe(204);
    const at = Date.now();
    const content = await api(
      member.page,
      member.orgId,
      "GET",
      `/api/comms/conversations/${room}/messages/${root.id}`,
    );
    const history = await api(
      member.page,
      member.orgId,
      "GET",
      `/api/comms/conversations/${room}/messages?limit=50`,
    );
    const refusedMs = Date.now() - at;
    expect(content.status).toBe(404);
    expect(history.status).toBe(404);
    return {
      contentStatus: content.status,
      historyStatus: history.status,
      refusedWithinMs: refusedMs,
    };
  });

  await step(
    "member sign-out does not sign out the administrator",
    async () => {
      await member.page
        .getByRole("button", { name: "Account", exact: true })
        .click();
      await member.page
        .getByRole("menuitem", { name: "Sign out", exact: true })
        .click();
      await expect(member.page).toHaveURL(/\/login$/u);
      const signedOut = await api(
        member.page,
        member.orgId,
        "GET",
        "/api/auth/session",
      );
      expect(object(signedOut.payload).authenticated).toBe(false);
      const stillAdmin = await api(
        admin.page,
        admin.orgId,
        "GET",
        "/api/auth/session",
      );
      expect(object(stillAdmin.payload).user_id).toBe(admin.id);
    },
  );

  expect(finish()).toEqual([]);
});
