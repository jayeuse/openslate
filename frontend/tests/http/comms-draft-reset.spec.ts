import { expect, test } from "./helpers/test";
import { installCommsWorld } from "./helpers/comms-world";
import { COMMS_DRAFT_TEXT_PREFIX } from "../../src/components/systems/comms/state/draft-text";

test("Comms keeps the composer usable and warns when draft text cannot be saved", async ({
  page,
}) => {
  await installCommsWorld(page);
  await page.goto("/comms");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  const warning = page
    .getByRole("form", { name: "Message composer", exact: true })
    .getByRole("status")
    .filter({ hasText: "Draft text cannot be saved in this browser." });
  const oldText = "An earlier saved draft";
  await message.fill(oldText);
  await expect(message).toHaveValue(oldText);
  await expect(warning).toHaveCount(0);
  const [draftKey, savedDraft] = await page.evaluate(
    ({ prefix, text }) => {
      const entry = Object.entries(sessionStorage).find(
        ([key, value]) => key.startsWith(prefix) && value.includes(text),
      );
      if (!entry) throw new Error("The composer draft was not saved");
      return entry;
    },
    { prefix: COMMS_DRAFT_TEXT_PREFIX, text: oldText },
  );

  // Only the owned draft's storage mutations fail. Reads still expose the old
  // bytes, so a write or a removal that claims success is visible here.
  const failure = await page.evaluateHandle((draftKey) => {
    const removeItem = Storage.prototype.removeItem;
    const setItem = Storage.prototype.setItem;
    const state = {
      restore() {
        Storage.prototype.removeItem = removeItem;
        Storage.prototype.setItem = setItem;
      },
    };
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (this === sessionStorage && key === draftKey)
        throw new DOMException("Blocked draft removal", "SecurityError");
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
    const newText = "A usable in-memory draft";
    await message.fill(newText);
    await expect(message).toHaveValue(newText);
    await expect(warning).toBeVisible();
    expect(
      await page.evaluate((key) => sessionStorage.getItem(key), draftKey),
    ).toBe(savedDraft);

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
