/** Existing commands owned by the Sandbox Build screen, not global shortcuts. */
export const SANDBOX_SHORTCUT_SCOPE = "Sandbox · Build";

export const COMMS_SHORTCUTS = {
  switchConversation: {
    key: "k",
    label: "Switch conversation",
    modifier: "Ctrl / Command",
  },
} as const;

/** Match only unhandled, deliberate Comms commands; owners gate profile/context. */
export function commsShortcutAction(
  event: KeyboardEvent,
  bindings: Record<string, string>,
) {
  if (event.defaultPrevented || event.repeat || event.isComposing)
    return undefined;
  const key = [
    event.altKey ? "Alt" : "",
    event.ctrlKey ? "Ctrl" : "",
    event.metaKey ? "Meta" : "",
    event.shiftKey ? "Shift" : "",
    event.key.length === 1 ? event.key.toUpperCase() : event.key,
  ]
    .filter(Boolean)
    .join("+");
  return Object.entries(bindings).find(
    ([, value]) => value.toLowerCase() === key.toLowerCase(),
  )?.[0];
}

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
