/** Existing commands owned by the Sandbox Build screen, not global shortcuts. */
export const SANDBOX_SHORTCUT_SCOPE = "Sandbox · Build";

export const COMMS_SHORTCUTS = {
  switchConversation: {
    key: "k",
    label: "Switch conversation",
    modifier: "Ctrl / Command",
  },
} as const;

const undo = {
  key: "z",
  label: "Undo",
  modifier: "Ctrl / Command",
  browserStandard: true,
} as const;

export const SANDBOX_SHORTCUTS = {
  help: { key: "?", label: "Canvas help", browserStandard: false },
  fit: { key: "0", label: "Fit canvas", browserStandard: false },
  remove: {
    key: "Delete",
    label: "Review removal of the selected item",
    browserStandard: false,
  },
  rename: {
    key: "F2",
    label: "Rename the selected item",
    browserStandard: false,
  },
  undo,
  redo: {
    key: "y",
    label: "Redo",
    modifier: undo.modifier,
    alternate: { key: undo.key, shift: true },
    browserStandard: true,
  },
} as const;

/** Display the same concrete bindings consumed by their existing owners. */
export function sandboxShortcutKeys(
  shortcut: (typeof SANDBOX_SHORTCUTS)[keyof typeof SANDBOX_SHORTCUTS],
): readonly string[] {
  if (!shortcut.browserStandard) return [shortcut.key];
  const keys = [`${shortcut.modifier} + ${shortcut.key.toUpperCase()}`];
  if ("alternate" in shortcut)
    keys.push(
      `${shortcut.modifier} + Shift + ${shortcut.alternate.key.toUpperCase()}`,
    );
  return keys;
}
