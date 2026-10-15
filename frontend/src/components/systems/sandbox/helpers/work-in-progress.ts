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
