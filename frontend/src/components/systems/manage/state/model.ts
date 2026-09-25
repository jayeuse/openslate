import { initialManageSessions, type ManageSession } from "./sessions";

export type ManageSettings = {
  name: string;
  logo: string;
  locale: string;
  timezone: string;
  currency: string;
  week: string;
  hours: string;
  password: string;
  timeout: string;
  mfa: string;
  ips: string;
  schedule: string;
  retention: string;
  version: string;
  previous: string;
  tier: string;
  expiry: string;
};
export type ManageSection = "organization" | "security" | "backup";
export type ManageTab = ManageSection | "audit" | "updates" | "licensing";
export type ManageValidationErrors = Partial<
  Record<keyof ManageSettings, string>
>;
export type ManageSnapshot = {
  id: string;
  name: string;
  date: string;
  settings: ManageSettings;
};
export type ManageSnapshotDiff = {
  key: keyof ManageSettings;
  label: string;
  before: string;
  after: string;
};
export type ManageActivityEntry = {
  id: string;
  user: string;
  date: string;
  entity: string;
  action: string;
  target: string;
  before: string;
  after: string;
  source: "example" | "manage";
};
export type ManageActionResult = { ok: boolean; message: string; id?: string };

export const initialManageSettings: ManageSettings = {
  name: "Riverside Services",
  logo: "RS",
  locale: "English (Philippines)",
  timezone: "Asia/Manila",
  currency: "PHP",
  week: "Monday",
  hours: "09:00–18:00",
  password: "12 characters + mixed case",
  timeout: "60 minutes",
  mfa: "Optional",
  ips: "192.0.2.0/24",
  schedule: "Daily at 02:00",
  retention: "30 days",
  version: "1.4.2",
  previous: "",
  tier: "Team",
  expiry: "2027-09-11",
};
export const manageOptions = {
  logo: ["RS", "R", "Compass"],
  locale: ["English (Philippines)", "Filipino", "English (US)"],
  timezone: ["Asia/Manila", "UTC", "Asia/Singapore"],
  currency: ["PHP", "USD", "SGD"],
  week: ["Monday", "Sunday"],
  password: [
    "12 characters + mixed case",
    "16 characters + mixed case + number",
    "20-character passphrase",
  ],
  timeout: ["15 minutes", "30 minutes", "60 minutes", "8 hours"],
  mfa: ["Optional", "Required for administrators", "Required for everyone"],
  schedule: ["Disabled", "Daily at 02:00", "Weekly on Sunday at 02:00"],
  retention: ["7 days", "30 days", "90 days"],
};
export const manageSectionKeys: Record<
  ManageSection,
  (keyof ManageSettings)[]
> = {
  organization: [
    "name",
    "logo",
    "locale",
    "timezone",
    "currency",
    "week",
    "hours",
  ],
  security: ["password", "timeout", "mfa", "ips"],
  backup: ["schedule", "retention"],
};
export const manageSettingLabels: Record<keyof ManageSettings, string> = {
  name: "Organization name",
  logo: "Organization logo",
  locale: "Locale",
  timezone: "Timezone",
  currency: "Currency",
  week: "Week starts on",
  hours: "Business hours",
  password: "Password policy",
  timeout: "Session timeout",
  mfa: "Two-factor authentication",
  ips: "IP allow list",
  schedule: "Backup schedule",
  retention: "Retention period",
  version: "Current version",
  previous: "Rollback version",
  tier: "License tier",
  expiry: "License expiry",
};
export const initialManageSnapshots: ManageSnapshot[] = [
  {
    id: "sample-backup-initial",
    name: "Scheduled snapshot",
    date: "2026-09-11 02:00",
    settings: { ...initialManageSettings },
  },
  {
    id: "sample-backup-after-setup",
    name: "After workspace setup",
    date: "2026-09-10 02:00",
    settings: { ...initialManageSettings },
  },
  {
    id: "sample-backup-weekly",
    name: "Weekly operations checkpoint",
    date: "2026-09-07 02:00",
    settings: { ...initialManageSettings },
  },
  {
    id: "sample-backup-before-release",
    name: "Before release review",
    date: "2026-09-05 16:30",
    settings: { ...initialManageSettings, version: "1.4.2" },
  },
  {
    id: "sample-backup-security",
    name: "Security policy checkpoint",
    date: "2026-09-03 09:15",
    settings: { ...initialManageSettings, mfa: "Required for administrators" },
  },
  {
    id: "sample-backup-operations",
    name: "Operations handoff",
    date: "2026-09-01 17:45",
    settings: { ...initialManageSettings, hours: "08:00–17:00" },
  },
];
export const initialManageActivity: ManageActivityEntry[] = [
  {
    id: "sample-audit-1",
    user: "Mara Santos",
    date: "2026-09-11",
    entity: "Work orders",
    action: "Update",
    target: "WO-1042",
    before: "Status: Assigned",
    after: "Status: In progress",
    source: "example",
  },
  {
    id: "sample-audit-2",
    user: "Eli Cruz",
    date: "2026-09-10",
    entity: "Equipment",
    action: "Create",
    target: "EQ-0028",
    before: "No equipment record",
    after: "Pump · North depot · Active",
    source: "example",
  },
  {
    id: "sample-audit-3",
    user: "Mara Santos",
    date: "2026-09-09",
    entity: "Users",
    action: "Close",
    target: "Nina Reyes",
    before: "User: Active",
    after: "User: Deactivated",
    source: "example",
  },
  {
    id: "sample-audit-4",
    user: "Iris Tan",
    date: "2026-09-08",
    entity: "Customers",
    action: "Update",
    target: "CUS-031",
    before: "Segment: Standard",
    after: "Segment: Priority",
    source: "example",
  },
  {
    id: "sample-audit-5",
    user: "Paolo Lim",
    date: "2026-09-07",
    entity: "Work orders",
    action: "Close",
    target: "WO-1038",
    before: "Status: In progress",
    after: "Status: Closed",
    source: "example",
  },
  {
    id: "sample-audit-6",
    user: "Lian Ong",
    date: "2026-09-06",
    entity: "Reports",
    action: "Create",
    target: "Weekly operations",
    before: "No report",
    after: "Report: Operations · Weekly",
    source: "example",
  },
  {
    id: "sample-audit-7",
    user: "Mara Santos",
    date: "2026-09-05",
    entity: "Departments",
    action: "Update",
    target: "Commercial",
    before: "Lead: Mara Santos",
    after: "Lead: Paolo Lim",
    source: "example",
  },
  {
    id: "sample-audit-8",
    user: "Ravi Patel",
    date: "2026-09-04",
    entity: "Backup",
    action: "Create",
    target: "Scheduled snapshot",
    before: "No checkpoint",
    after: "Configuration snapshot saved",
    source: "example",
  },
  {
    id: "sample-audit-9",
    user: "Eli Cruz",
    date: "2026-09-03",
    entity: "Equipment",
    action: "Update",
    target: "EQ-0017",
    before: "Status: Maintenance",
    after: "Status: Active",
    source: "example",
  },
  {
    id: "sample-audit-10",
    user: "Nina Reyes",
    date: "2026-09-02",
    entity: "Users",
    action: "Invite",
    target: "Tomas Yu",
    before: "No user record",
    after: "Invitation: Pending",
    source: "example",
  },
];
type Drafts = Partial<Record<ManageSection, Partial<ManageSettings>>>;
export type ManageState = {
  settings: ManageSettings;
  backups: ManageSnapshot[];
  sessions: ManageSession[];
  history: string[];
  activity: ManageActivityEntry[];
  drafts: Drafts;
};
export const initialManageState: ManageState = {
  settings: initialManageSettings,
  backups: initialManageSnapshots,
  sessions: initialManageSessions,
  history: ["Installed version 1.4.2"],
  activity: initialManageActivity,
  drafts: {},
};
