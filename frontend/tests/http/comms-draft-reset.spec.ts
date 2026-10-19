import { defaultOrganization, expect, signedInAs, test } from "./helpers/test";
import { COMMS_DRAFT_TEXT_PREFIX } from "../../src/components/systems/comms/state/draft-text";
import { workspaceSessionSnapshotStorageKey } from "../../src/components/systems/shared/runtime/workspace-identity";

test("Comms reset keeps a fresh composer usable when draft storage cannot be cleared", async ({
  page,
}) => {
  const userId = "00000000-0000-4000-8000-000000000101";
  await signedInAs(page, { id: userId, role: "admin" });
  // Use the real recovery/reset UI, not a test-mounted provider or store copy.
  await page.addInitScript(
    (key) => sessionStorage.setItem(key, "{"),
    workspaceSessionSnapshotStorageKey(userId, defaultOrganization.org_id),
  );
  await page.goto("/comms");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const warning = page
    .getByRole("form", { name: "Message composer", exact: true })
    .getByRole("status")
    .filter({ hasText: "Draft text cannot be saved in this browser." });
  const oldText = "Discard this pre-reset draft";
  await message.fill(oldText);
  await expect(message).toHaveValue(oldText);
  await expect(warning).toHaveCount(0);
  const [draftKey, savedDraft] = await page.evaluate(
    ({ prefix, text }) => {
      const entry = Object.entries(sessionStorage).find(
        ([key, value]) => key.startsWith(prefix) && value.includes(text),
      );
      if (!entry) throw new Error("The pre-reset composer draft was not saved");
      return entry;
    },
    { prefix: COMMS_DRAFT_TEXT_PREFIX, text: oldText },
  );

  // Only the owned draft's storage mutations fail. Reads still expose the old
  // bytes, so dropping the retired entry and blindly restoring also fails here.
  const failure = await page.evaluateHandle((draftKey) => {
    const removeItem = Storage.prototype.removeItem;
    const setItem = Storage.prototype.setItem;
    const state = {
      removals: 0,
      restore() {
        Storage.prototype.removeItem = removeItem;
        Storage.prototype.setItem = setItem;
      },
    };
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (this === sessionStorage && key === draftKey) {
        state.removals += 1;
        throw new DOMException("Blocked draft removal", "SecurityError");
      }
      return removeItem.call(this, key);
    };
    Storage.prototype.setItem = function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === sessionStorage && key === draftKey)
        throw new DOMException("Blocked draft write", "SecurityError");
      return setItem.call(this, key, value);
    };
    return state;
  }, draftKey);
  try {
    await page
      .getByRole("button", { name: "Reset workspace data", exact: true })
      .click();
    const reset = page.getByRole("dialog", {
      name: "Reset workspace data?",
      exact: true,
    });
    await reset
      .getByRole("button", { name: "Reset workspace", exact: true })
      .click();
    await expect(reset).toBeHidden();
    expect(await failure.evaluate((state) => state.removals)).toBeGreaterThan(
      0,
    );
    await expect(message).toHaveValue("");
    await expect(warning).toBeVisible();

    const newText = "A usable in-memory draft after reset";
    await message.fill(newText);
    await expect(message).toHaveValue(newText);
    await expect(warning).toBeVisible();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), draftKey),
    ).toBe(savedDraft);

    // A delayed storage notification must not replace the new owner's text with
    // the readable bytes that reset could not remove, or hide the warning.
    await page.evaluate(
      ({ key, value }) => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key,
            newValue: value,
            storageArea: sessionStorage,
          }),
        );
      },
      { key: draftKey, value: savedDraft },
    );
    await expect(message).toHaveValue(newText);
    await expect(warning).toBeVisible();

    // Sending proves the new text reached the live draft owner, not just the DOM.
    const send = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(
      page.getByRole("article").filter({ hasText: newText }),
    ).toBeVisible();
    await expect(message).toHaveValue("");
    await expect(warning).toBeVisible();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), draftKey),
    ).toBe(savedDraft);
  } finally {
    await failure.evaluate((state) => state.restore());
    await failure.dispose();
  }
});
