import { expect, test } from "@playwright/test";
import {
  shouldSendMessage,
  type SubmitKeystroke,
} from "../../../src/components/systems/comms/domain/composer-input";

test("composer shortcuts never submit IME confirmation or Shift+Enter", () => {
  const enter: SubmitKeystroke = {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
  };
  for (const [shortcut, input, expected] of [
    ["enter", enter, true],
    ["enter", { ...enter, shiftKey: true }, false],
    ["ctrl-enter", enter, false],
    ["ctrl-enter", { ...enter, ctrlKey: true }, true],
    ["ctrl-enter", { ...enter, metaKey: true }, true],
    ["ctrl-enter", { ...enter, ctrlKey: true, shiftKey: true }, false],
    ["enter", { ...enter, isComposing: true }, false],
    ["ctrl-enter", { ...enter, ctrlKey: true, isComposing: true }, false],
    ["enter", { ...enter, keyCode: 229 }, false],
    ["ctrl-enter", { ...enter, metaKey: true, keyCode: 229 }, false],
  ] as const)
    expect.soft(shouldSendMessage(input, shortcut)).toBe(expected);
});
