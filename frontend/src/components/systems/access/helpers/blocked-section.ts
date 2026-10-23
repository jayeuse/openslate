/** The Access sections only an administrator opens, by their sidebar names. */
const adminSections = {
  overview: "Overview",
  people: "People",
  security: "Security",
} as const;

/**
 * The line a department manager sees after a link to another Access section
 * lands them on Groups, or null when the link asked for Groups or for no
 * section. A person link without a view opens People.
 */
export function blockedSectionNotice(search: URLSearchParams): string | null {
  const view = search.get("view") ?? (search.has("user") ? "people" : null);
  if (view === null || !Object.hasOwn(adminSections, view)) return null;
  const name = adminSections[view as keyof typeof adminSections];
  return `${name} is not available to your account.`;
}
