import type { CommsPreferences } from "./configuration";
import { commsFailureSchema } from "../contract/schemas";

export type SubmitKeystroke = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode"
>;

// IME confirmation must never turn into a send, including legacy WebKit 229.
export function shouldSendMessage(
  event: SubmitKeystroke,
  shortcut: CommsPreferences["sendShortcut"],
) {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    (shortcut === "enter" || event.ctrlKey || event.metaKey)
  );
}

export const attachmentTypes = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "docx",
  "xlsx",
  "pptx",
];
export function hasMention(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s.,!?;:()])`, "u").test(text);
}
export function composerFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("failure" in error))
    return undefined;
  const result = commsFailureSchema.safeParse(error.failure);
  return result.success ? result.data : undefined;
}
