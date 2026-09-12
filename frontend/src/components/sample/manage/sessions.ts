export type ManageSession = {
  id: string;
  personId: string;
  personName: string;
  device: string;
  browser: string;
  location: string;
  lastSeen: string;
  current: boolean;
};

export const initialManageSessions: ManageSession[] = [
  {
    id: "sample-session-mara-current",
    personId: "sample-mara",
    personName: "Mara",
    device: "Desktop",
    browser: "Chrome",
    location: "Manila",
    lastSeen: "Now",
    current: true,
  },
  {
    id: "sample-session-eli-mobile",
    personId: "sample-eli",
    personName: "Eli",
    device: "Mobile",
    browser: "Chrome",
    location: "Quezon City",
    lastSeen: "12 minutes ago",
    current: false,
  },
];
