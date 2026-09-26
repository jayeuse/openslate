export type WorkspaceNavigationItem = {
  id: string;
  label: string;
  href: string;
};

export type WorkspaceNavigationGroup = {
  id: string;
  label: string;
  href: string;
  items: readonly WorkspaceNavigationItem[];
};

type WorkspaceNavigationDefinition = {
  id: string;
  label: string;
  pathname: string;
  queryKey: "section" | "view";
  defaultItem: string;
  items: readonly { id: string; label: string }[];
};

const workspaceNavigationDefinitions = [
  {
    id: "sandbox",
    label: "Sandbox",
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
    pathname: "/boards",
    queryKey: "section",
    defaultItem: "overview",
    items: [
      { id: "announcements", label: "Announcements" },
      { id: "calendar", label: "Calendar" },
      { id: "overview", label: "Overview" },
    ],
  },
  {
    id: "access",
    label: "Access",
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
    pathname: "/manage",
    queryKey: "view",
    defaultItem: "organization",
    items: [
      { id: "organization", label: "Organization" },
      { id: "security", label: "Security & recovery" },
      { id: "audit", label: "Audit" },
      { id: "updates", label: "Updates" },
      { id: "licensing", label: "Licensing" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
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
      href: defaultItem?.href ?? definition.pathname,
      items,
    };
  });
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
