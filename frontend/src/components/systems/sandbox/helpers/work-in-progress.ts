/** The Sandbox states that make leaving the page lose or interrupt work. */
export type SandboxWork = {
  commandBusy: boolean;
  publicationPending: boolean;
  testPending: boolean;
  conflict: boolean;
  triggerDraftDirty: boolean;
  triggerDraftPending: boolean;
  designerDraftDirty: boolean;
};

/** One rule for section navigation, the workspace navigation guard, and browser exits. */
export function sandboxWorkInProgress(work: SandboxWork): boolean {
  return (
    work.commandBusy ||
    work.publicationPending ||
    work.testPending ||
    work.conflict ||
    work.triggerDraftDirty ||
    work.triggerDraftPending ||
    work.designerDraftDirty
  );
}

/**
 * The page keeps unsaved trigger edits across its sections, so they hold a
 * move only when it leaves the Triggers section or leaves the Sandbox
 * (`to` is null). Moving into Triggers never waits: that is where they save.
 */
export function triggerEditsHoldMove(from: string, to: string | null): boolean {
  if (to === "Triggers") return false;
  return from === "Triggers" || to === null;
}
