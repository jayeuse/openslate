export type WorkspaceNavigationItem = {
  id: string;
  label: string;
  href: string;
};

export type WorkspaceNavigationGroup = {
  id: string;
  label: string;
  description?: string;
  href: string;
  items: readonly WorkspaceNavigationItem[];
};

type WorkspaceNavigationDefinition = {
  id: string;
  label: string;
  description?: string;
  pathname: string;
  queryKey: "section" | "view";
  defaultItem: string;
  items: readonly { id: string; label: string }[];
};

const workspaceNavigationDefinitions = [
  {
    id: "sandbox",
    label: "Sandbox",
    description: "Design departments and records",
    pathname: "/sandbox",
    queryKey: "section",
    defaultItem: "build",
    items: [
      { id: "build", label: "Build" },
      { id: "automations", label: "Automations" },
      { id: "test", label: "Test" },
      { id: "history", label: "History" },
    ],
  },
  {
    id: "boards",
    label: "Boards",
    description: "Team pages and events",
    pathname: "/boards",
    queryKey: "section",
    defaultItem: "overview",
    items: [
      { id: "overview", label: "Overview" },
      { id: "announcements", label: "Announcements" },
      { id: "calendar", label: "Calendar" },
    ],
  },
  {
    id: "access",
    label: "Access",
    description: "Who can see and change what",
    pathname: "/access",
    queryKey: "view",
    defaultItem: "overview",
    items: [
      { id: "overview", label: "Overview" },
      { id: "identities", label: "People & services" },
      { id: "permissions", label: "Permissions" },
    ],
  },
  {
    id: "openview",
    label: "OpenView",
    description: "Browse records and reports",
    pathname: "/openview",
    queryKey: "section",
    defaultItem: "views",
    items: [
      { id: "views", label: "Views" },
      { id: "dashboards", label: "Dashboards" },
      { id: "charts", label: "Charts" },
      { id: "reports", label: "Reports" },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    description: "Organization settings and audit",
    pathname: "/manage",
    queryKey: "view",
    defaultItem: "organization",
    items: [
      { id: "organization", label: "Organization" },
      { id: "security", label: "Security & recovery" },
      { id: "audit", label: "Audit" },
      { id: "updates", label: "Updates & licensing" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    description: "Account, files, and alerts",
    pathname: "/platform",
    queryKey: "section",
    defaultItem: "search",
    items: [
      { id: "search", label: "Search" },
      { id: "notifications", label: "Notifications" },
      { id: "import-export", label: "Import & export" },
      { id: "account", label: "Account & presence" },
      { id: "files", label: "File library" },
      { id: "records", label: "Record actions" },
    ],
  },
] as const satisfies readonly WorkspaceNavigationDefinition[];

// Match the identifier boundary used by OpenView before its record link
// overrides the requested section.
const openViewRecordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sandboxLegacySections: Readonly<Record<string, string>> = {
  designer: "build",
  automation: "automations",
  simulation: "test",
  preview: "test",
  versions: "history",
};

function href(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function sectionFor(
  definition: WorkspaceNavigationDefinition,
  params: URLSearchParams,
  hash = "",
): string {
  const requested = params.get(definition.queryKey);
  const normalizedRequested =
    definition.id === "sandbox" && requested
      ? (sandboxLegacySections[requested.toLowerCase()] ??
        requested.toLowerCase())
      : requested;
  if (definition.id === "manage" && requested?.toLowerCase() === "backup")
    return "security";
  if (definition.id === "manage" && requested?.toLowerCase() === "licensing")
    return "updates";
  if (definition.id === "access" && requested === "simulator")
    return "identities";
  if (definition.id === "access" && requested === "reviews") return "overview";
  if (
    definition.id === "access" &&
    ["roles", "groups", "rules"].includes(requested ?? "")
  )
    return "permissions";
  if (
    definition.id === "openview" &&
    openViewRecordIdPattern.test(params.get("record") ?? "")
  )
    return "views";
  const matched = definition.items.find(
    (item) => item.id === normalizedRequested,
  );
  if (matched) return matched.id;
  if (definition.id === "access" && params.has("user")) return "identities";
  if (requested !== null) return definition.defaultItem;
  if (definition.id === "sandbox" && params.has("rule")) return "automations";
  if (definition.id === "platform") {
    if (hash === "#account") return "account";
    if (hash === "#notifications") return "notifications";
    if (params.has("file")) return "files";
  }
  return definition.defaultItem;
}

function paramsFor(
  definition: WorkspaceNavigationDefinition,
  itemId: string,
  pathname: string,
  searchParams: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set(definition.queryKey, itemId);

  if (pathname === definition.pathname) {
    if (definition.id === "sandbox") {
      for (const [key, value] of searchParams) {
        if (key !== "section") params.append(key, value);
      }
    }
    if (definition.id === "boards") {
      const board = searchParams.get("board");
      if (board) params.set("board", board);
    }
    if (definition.id === "access") {
      if (itemId === "identities") {
        const user = searchParams.get("user");
        if (user) params.set("user", user);
      }
    }
    if (definition.id === "openview") {
      const moduleId = searchParams.get("module");
      if (moduleId) params.set("module", moduleId);
      if (itemId === "views") {
        const view = searchParams.get("view");
        if (view) params.set("view", view);
      }
      if (itemId === "dashboards") {
        const dashboard = searchParams.get("dashboard");
        if (dashboard) params.set("dashboard", dashboard);
      }
    }
    if (definition.id === "platform" && itemId === "files") {
      const file = searchParams.get("file");
      if (file) params.set("file", file);
    }
  }

  return params;
}

export function getWorkspaceNavigation(
  pathname: string,
  searchParams: URLSearchParams,
): readonly WorkspaceNavigationGroup[] {
  return workspaceNavigationDefinitions.map((definition) => {
    const items = definition.items.map((item) => ({
      ...item,
      href: href(
        definition.pathname,
        paramsFor(definition, item.id, pathname, searchParams),
      ),
    }));
    const defaultItem = items.find(
      (item) => item.id === definition.defaultItem,
    );
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      href: defaultItem?.href ?? definition.pathname,
      items,
    };
  });
}

export type WorkspaceLocation = {
  workspace: { label: string; href: string };
  section: string;
};

/** The workspace and open section a URL shows, for the breadcrumb. */
export function getWorkspaceLocation(
  pathname: string,
  searchParams: URLSearchParams,
  hash = "",
): WorkspaceLocation | null {
  const definition = workspaceNavigationDefinitions.find(
    (candidate) => candidate.pathname === pathname,
  );
  if (!definition) return null;
  const sectionId = sectionFor(definition, searchParams, hash);
  const group = getWorkspaceNavigation(pathname, searchParams).find(
    (candidate) => candidate.id === definition.id,
  );
  const section = definition.items.find((item) => item.id === sectionId);
  if (!group || !section) return null;
  return {
    workspace: { label: group.label, href: group.href },
    section: section.label,
  };
}

export function isWorkspaceNavigationItemActive(
  groupId: string,
  itemId: string,
  pathname: string,
  searchParams: URLSearchParams,
  hash = "",
): boolean {
  const definition = workspaceNavigationDefinitions.find(
    (entry) => entry.id === groupId,
  );
  const item = definition?.items.find((entry) => entry.id === itemId);
  return Boolean(
    definition &&
    item &&
    pathname === definition.pathname &&
    sectionFor(definition, searchParams, hash) === item.id,
  );
}

export function isWorkspaceNavigationGroupActive(
  group: WorkspaceNavigationGroup,
  pathname: string,
): boolean {
  return group.href.split("?")[0] === pathname;
}

export type NavigationTransitionType = "nav-down" | "nav-up";

/**
 * The direction of a sidebar move, for the page handoff animation: moving
 * to an item lower in the sidebar is "nav-down", higher is "nav-up". Order
 * keys are `group:item`. Null when there is no move to show.
 */
export function navigationTransitionType(
  order: readonly string[],
  from: string | null,
  to: string,
): NavigationTransitionType | null {
  if (from === null || from === to) return null;
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return null;
  return toIndex > fromIndex ? "nav-down" : "nav-up";
}

/** OpenComms and Appearance sit below the sidebar groups. */
export const COMMS_NAVIGATION_KEY = "comms";
export const APPEARANCE_NAVIGATION_KEY = "appearance";

/**
 * Every place the sidebar can take you, top to bottom, as `group:item` keys
 * followed by OpenComms and Appearance. Page handoffs read their direction
 * from this order.
 */
export function navigationOrder(): string[] {
  return [
    ...workspaceNavigationDefinitions.flatMap((definition) =>
      definition.items.map((item) => `${definition.id}:${item.id}`),
    ),
    COMMS_NAVIGATION_KEY,
    APPEARANCE_NAVIGATION_KEY,
  ];
}

/** The navigation key of the place a URL shows, or null outside the sidebar. */
export function currentNavigationKey(
  pathname: string,
  searchParams: URLSearchParams,
  hash = "",
): string | null {
  if (pathname === "/comms" || pathname.startsWith("/comms/"))
    return COMMS_NAVIGATION_KEY;
  if (pathname === "/settings/appearance") return APPEARANCE_NAVIGATION_KEY;
  const definition = workspaceNavigationDefinitions.find(
    (candidate) => candidate.pathname === pathname,
  );
  if (!definition) return null;
  return `${definition.id}:${sectionFor(definition, searchParams, hash)}`;
}

/** The key a workspace's own link opens: its first (default) section. */
export function workspaceDefaultNavigationKey(href: string): string | null {
  const definition = workspaceNavigationDefinitions.find(
    (candidate) => candidate.pathname === href.split("?")[0],
  );
  return definition ? `${definition.id}:${definition.defaultItem}` : null;
}
