/**
 * Who reads an error reference (D6, docs/specs/system-health.md): the words
 * after a reference name the person to give it to, and that depends on the
 * viewer's role in the bound organization. Members, guests and a page with no
 * identity yet read "your administrator"; an organization admin reads "the
 * person who runs your server"; the installation owner is that person.
 */
export type ReferenceViewer = "member" | "admin" | "owner";

/**
 * The viewer from the identity: the current membership role of the bound
 * organization, the same test as the Jobs tab. The installation owner wins
 * only as an admin of this organization (`installationOwnerFor`).
 */
export function referenceViewerFor(
  identity: { role: string | null; operator: boolean } | undefined,
): ReferenceViewer {
  if (identity?.role !== "admin") return "member";
  return identity.operator ? "owner" : "admin";
}

/** `ErrorReference` line 2; the owner reads none (D6). */
export function referenceAdvice(viewer: ReferenceViewer): string | null {
  if (viewer === "owner") return null;
  return viewer === "admin"
    ? "Give this reference to the person who runs your server."
    : "Give this reference to your administrator.";
}

/** System health block 6, paragraph 2 (D6). */
export function notLoadingAdvice(viewer: ReferenceViewer): string {
  const first =
    "When Slate Operations does not load: wait a minute and reload.";
  if (viewer === "owner")
    return `${first} If it still does not load, check that your server is running.`;
  return viewer === "admin"
    ? `${first} If it still does not load, tell the person who runs your server.`
    : `${first} If it still does not load, tell your administrator.`;
}

// The signed-in viewer for every reference on the page, toasts included:
// the toaster mounts in the root layout, outside AppPage's providers, so the
// viewer lives in one module store that AppPage sets from the identity.
let current: ReferenceViewer = "member";
const listeners = new Set<() => void>();

export function setReferenceViewer(next: ReferenceViewer): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function referenceViewer(): ReferenceViewer {
  return current;
}

export function subscribeReferenceViewer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
