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
      { id: "jobs", label: "Jobs" },
      { id: "updates", label: "Updates & licensing" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    description: "Files, search, and import & export",
    pathname: "/platform",
    queryKey: "section",
    defaultItem: "search",
    items: [
      { id: "search", label: "Search" },
      { id: "files", label: "Files" },
      { id: "notifications", label: "Notifications" },
      { id: "import-export", label: "Import & export" },
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
 * failed to load, sees no Access entry. Only "all" (an administrator) also
 * sees the Sandbox. The backend enforces every rule; this only hides
 * controls that would be refused.
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

/**
 * Whether the signed-in person sees Manage's Backup and Updates & licensing.
 * Their APIs require an administrator of the bound organization who also owns
 * the installation (`require_fresh_exact_admin`, then
 * `require_platform_operator`). A loading or failed identity sees neither.
 */
export function installationOwnerFor(
  identity: Pick<AuthMe, "role" | "operator"> | undefined,
): boolean {
  return identity?.role === "admin" && identity.operator;
}

/**
 * The departments whose audit a person may read when Audit is scoped (MD12).
 * The audit list admits an administrator for the whole organization (null),
 * and anyone else only with a `department_id` whose department level is
 * manage (`audit/router.py`). A guest is capped at read and a module-only
 * manager has no department level, so both get none.
 */
export function auditDepartmentsFor(
  identity: Pick<AuthMe, "role" | "access"> | undefined,
): string[] | null {
  if (identity?.role === "admin") return null;
  if (identity?.role !== "member") return [];
  return [
    ...new Set(
      identity.access
        .filter((entry) => entry.moduleId === null && entry.level === "manage")
        .map((entry) => entry.departmentId),
    ),
  ];
}

/**
 * Which Manage sections a person sees (MD3, docs/specs/manage-relayout.md):
 * Organization for everyone; Audit for an administrator (`require_admin`) and
 * a department manager (MD12, the page sends `department_id`); Jobs for a
 * verified administrator; Backup and Updates for the installation owner.
 */
function visibleManageItem(
  id: string,
  access: AccessNavigation,
  jobsAdmitted: boolean,
  installationOwner: boolean,
  auditManager: boolean,
): boolean {
  if (id === "audit") return access === "all" || auditManager;
  if (id === "jobs") return jobsAdmitted;
  if (id === "backup" || id === "updates") return installationOwner;
  return true;
}

function visibleItems(
  definition: WorkspaceNavigationDefinition,
  access: AccessNavigation,
  jobsAdmitted: boolean,
  installationOwner: boolean,
  auditManager: boolean,
): readonly { id: string; label: string }[] {
  const items = definition.items;
  // Module pages, dashboards and reports live under the departments (DA5,
  // BD1, DC9), so the sidebar has no OpenView item. Its definition stays for
  // the navigation keys and the help guide of /openview.
  if (definition.id === "openview") return [];
  // Every Sandbox API requires an administrator (`require_admin`).
  if (definition.id === "sandbox") return access === "all" ? items : [];
  if (definition.id === "manage")
    return items.filter((item) =>
      visibleManageItem(
        item.id,
        access,
        jobsAdmitted,
        installationOwner,
        auditManager,
      ),
    );
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
  }

  return params;
}

export function getWorkspaceNavigation(
  pathname: string,
  searchParams: URLSearchParams,
  access: AccessNavigation,
  jobsAdmitted = false,
  installationOwner = false,
  auditManager = false,
): readonly WorkspaceNavigationGroup[] {
  return workspaceNavigationDefinitions.flatMap((definition) => {
    const items = visibleItems(
      definition,
      access,
      jobsAdmitted,
      installationOwner,
      auditManager,
    ).map((item) => ({
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
  // A current URL's breadcrumb names its section; it does not admit a menu or
  // read. Manage names every section, since a link to one this person cannot
  // open lands on a notice with that section's title.
  const group = getWorkspaceNavigation(
    pathname,
    searchParams,
    access,
    definition.id === "manage",
    definition.id === "manage",
  ).find((candidate) => candidate.id === definition.id);
  const section =
    definition.id === "manage"
      ? definition.items.find((item) => item.id === sectionId)
      : group?.items.find((item) => item.id === sectionId);
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

/** OpenComms, Profile and Account settings sit outside the sidebar groups. */
const COMMS_NAVIGATION_KEY = "comms";
const PROFILE_NAVIGATION_KEY = "profile";
const SETTINGS_NAVIGATION_KEY = "account-settings";

/** The navigation key of the place a URL shows, or null outside the sidebar. */
export function currentNavigationKey(
  pathname: string,
  searchParams: URLSearchParams,
  hash = "",
): string | null {
  if (pathname === "/comms" || pathname.startsWith("/comms/"))
    return COMMS_NAVIGATION_KEY;
  if (pathname === "/profile") return PROFILE_NAVIGATION_KEY;
  if (pathname === "/settings" || pathname === "/settings/appearance")
    return SETTINGS_NAVIGATION_KEY;
  const definition = workspaceNavigationDefinitions.find(
    (candidate) => candidate.pathname === pathname,
  );
  if (!definition) return null;
  const section = sectionFor(definition, searchParams, hash);
  // Each module page and dashboard is its own place, so the fill glides;
  // the "openview" prefix keeps OpenView's help guide.
  if (
    definition.id === "openview" &&
    searchParams.get("section") === "dashboards"
  )
    return `openview:dashboard:${searchParams.get("department") ?? ""}`;
  if (definition.id === "openview" && section === "views")
    return `openview:module:${searchParams.get("module") ?? ""}`;
  return `${definition.id}:${section}`;
}

/**
 * What a navigation leaves besides the page: the signed-in session (sign-out)
 * or the organization (a switch). Both clear the tab's saved drafts.
 */
export type WorkspaceNavigationExit = "session" | "organization";

/** A link that names an organization leaves the current one only when it names another. */
export function organizationLinkExit(
  target: string | undefined,
  current: string | null,
): WorkspaceNavigationExit | undefined {
  return target !== undefined && target !== current
    ? "organization"
    : undefined;
}
