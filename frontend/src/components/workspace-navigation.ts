import type { AuthMe } from "@/lib/auth-api";

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
      { id: "triggers", label: "Triggers" },
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
      { id: "posts", label: "Posts" },
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
      { id: "people", label: "People" },
      { id: "groups", label: "Groups" },
      { id: "security", label: "Security" },
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
      { id: "backup", label: "Backup" },
      { id: "audit", label: "Audit" },
      { id: "updates", label: "Updates & licensing" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    description: "Account, search, and alerts",
    pathname: "/platform",
    queryKey: "section",
    defaultItem: "search",
    items: [
      { id: "search", label: "Search" },
      { id: "files", label: "Files" },
      { id: "notifications", label: "Notifications" },
      { id: "import-export", label: "Import & export" },
      { id: "account", label: "Account" },
    ],
  },
] as const satisfies readonly WorkspaceNavigationDefinition[];

// Match the identifier boundary used by OpenView before its record link
// overrides the requested section.
const openViewRecordIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const sandboxLegacySections: Readonly<Record<string, string>> = {
  designer: "build",
  trigger: "triggers",
  simulation: "test",
  preview: "test",
  versions: "history",
};

/**
 * Which Access entries the signed-in person sees (schema redesign D13).
 * Administrators see every entry. A member with `manage` on any department
 * or module sees only Groups, where they change the members of the groups
 * they manage. Everyone else, and an identity that is still loading or
 * failed to load, sees no Access entry. The backend enforces every rule;
 * this only hides controls that would be refused.
 */
export type AccessNavigation = "all" | "groups" | "none";

export function accessNavigationFor(
  identity: Pick<AuthMe, "role" | "access"> | undefined,
): AccessNavigation {
  if (!identity) return "none";
  if (identity.role === "admin") return "all";
  if (
    identity.role === "member" &&
    identity.access.some((entry) => entry.level === "manage")
  )
    return "groups";
  return "none";
}

function visibleItems(
  definition: WorkspaceNavigationDefinition,
  access: AccessNavigation,
): readonly { id: string; label: string }[] {
  const items = definition.items;
  if (definition.id !== "access" || access === "all") return items;
  if (access === "groups") return items.filter((item) => item.id === "groups");
  return [];
}

function href(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function sectionFor(
  definition: WorkspaceNavigationDefinition,
  params: URLSearchParams,
  hash = "",
  access: AccessNavigation = "all",
): string {
  if (definition.id === "access" && access === "groups") return "groups";
  const requested = params.get(definition.queryKey);
  const normalizedRequested =
    definition.id === "sandbox" && requested
      ? (sandboxLegacySections[requested.toLowerCase()] ??
        requested.toLowerCase())
      : requested;
  if (definition.id === "manage" && requested?.toLowerCase() === "backup")
    return "backup";
  if (definition.id === "manage" && requested?.toLowerCase() === "licensing")
    return "updates";
  if (
    definition.id === "openview" &&
    openViewRecordIdPattern.test(params.get("record") ?? "")
  )
    return "views";
  const matched = definition.items.find(
    (item) => item.id === normalizedRequested,
  );
  if (matched) return matched.id;
  if (definition.id === "access" && params.has("user")) return "people";
  if (requested !== null) return definition.defaultItem;
  if (definition.id === "sandbox" && params.has("rule")) return "triggers";
  if (definition.id === "platform") {
    if (hash === "#account") return "account";
    if (hash === "#notifications") return "notifications";
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
    if (definition.id === "platform") {
      const department = searchParams.get("department");
      if (department) params.set("department", department);
    }
    if (definition.id === "access") {
      if (itemId === "people") {
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
      if (itemId === "reports") {
        for (const key of ["report", "run"]) {
          const value = searchParams.get(key);
          if (value) params.set(key, value);
        }
      }
      if (itemId === "dashboards") {
        const dashboard = searchParams.get("dashboard");
        if (dashboard) params.set("dashboard", dashboard);
      }
    }
  }

  return params;
}

export function getWorkspaceNavigation(
  pathname: string,
  searchParams: URLSearchParams,
  access: AccessNavigation,
): readonly WorkspaceNavigationGroup[] {
  return workspaceNavigationDefinitions.flatMap((definition) => {
    const items = visibleItems(definition, access).map((item) => ({
      ...item,
      href: href(
        definition.pathname,
        paramsFor(definition, item.id, pathname, searchParams),
      ),
    }));
    if (items.length === 0) return [];
    // The workspace link opens its default section, or the first section
    // this person sees when the default is hidden.
    const defaultItem =
      items.find((item) => item.id === definition.defaultItem) ?? items[0];
    return [
      {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        href: defaultItem?.href ?? definition.pathname,
        items,
      },
    ];
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
  hash: string,
  access: AccessNavigation,
): WorkspaceLocation | null {
  const definition = workspaceNavigationDefinitions.find(
    (candidate) => candidate.pathname === pathname,
  );
  if (!definition) return null;
  const sectionId = sectionFor(definition, searchParams, hash, access);
  const group = getWorkspaceNavigation(pathname, searchParams, access).find(
    (candidate) => candidate.id === definition.id,
  );
  const section = group?.items.find((item) => item.id === sectionId);
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

/** OpenComms and Appearance sit below the sidebar groups. */
const COMMS_NAVIGATION_KEY = "comms";
const APPEARANCE_NAVIGATION_KEY = "appearance";

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
