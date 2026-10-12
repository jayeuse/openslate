const PLATFORM_SECTIONS = {
  search: "Search",
  files: "Files",
  notifications: "Notifications",
  "import-export": "Import & export",
  account: "Account",
} as const;

type PlatformSection =
  (typeof PLATFORM_SECTIONS)[keyof typeof PLATFORM_SECTIONS];

export function platformSectionFromSearch(
  requestedSection: string | null,
  hash: string,
): PlatformSection {
  if (requestedSection !== null)
    return Object.hasOwn(PLATFORM_SECTIONS, requestedSection)
      ? PLATFORM_SECTIONS[requestedSection as keyof typeof PLATFORM_SECTIONS]
      : "Search";
  if (hash === "#account") return "Account";
  if (hash === "#notifications") return "Notifications";
  return "Search";
}
