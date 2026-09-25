export type PlatformNotificationPreferences = {
  threads: boolean;
  records: boolean;
  digest: boolean;
};

export const INITIAL_PLATFORM_PREFERENCES: PlatformNotificationPreferences = {
  threads: true,
  records: true,
  digest: false,
};

export type PlatformAccount = {
  language: string;
  theme: string;
  presence: string;
  passwordChanged: boolean;
  signedOut: boolean;
};

export const INITIAL_PLATFORM_ACCOUNT: PlatformAccount = {
  language: "English",
  theme: "Light",
  presence: "Available",
  passwordChanged: false,
  signedOut: false,
};

export type PlatformSession = {
  id: string;
  device: string;
  current: boolean;
};

export const INITIAL_PLATFORM_SESSIONS: PlatformSession[] = [
  { id: "sample-current", device: "This browser", current: true },
  { id: "sample-tablet", device: "Workshop tablet", current: false },
];

export const PLATFORM_FILES = [
  {
    id: "sample-file-checklist",
    name: "Inspection checklist.pdf",
    recordId: "sample-sr-1004",
    type: "PDF",
    size: "142 KB",
  },
  {
    id: "sample-file-workshop",
    name: "Workshop photo.jpg",
    recordId: "sample-sr-1005",
    type: "Image",
    size: "840 KB",
  },
  {
    id: "sample-file-report",
    name: "Service report.xlsx",
    recordId: "sample-sr-1006",
    type: "Spreadsheet",
    size: "28 KB",
  },
] as const;

export type PlatformFile = (typeof PLATFORM_FILES)[number];

export type PlatformImportRow = {
  title: string;
  customer: string;
  assignee: string;
  dueDate: string;
};
