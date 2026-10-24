/** The save-state chip while a draft differs from the saved values (Manage › Organization, Account settings). */
export function unsavedChangesLabel(count: number): string {
  return `${count} unsaved ${count === 1 ? "change" : "changes"}`;
}
