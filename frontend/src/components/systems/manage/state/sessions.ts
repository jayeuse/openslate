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
  {
    id: "sample-session-iris-laptop",
    personId: "sample-person-iris-tan",
    personName: "Iris",
    device: "Laptop",
    browser: "Safari",
    location: "Makati",
    lastSeen: "28 minutes ago",
    current: false,
  },
  {
    id: "sample-session-paolo-desktop",
    personId: "sample-person-paolo-lim",
    personName: "Paolo",
    device: "Desktop",
    browser: "Edge",
    location: "Cebu City",
    lastSeen: "1 hour ago",
    current: false,
  },
  {
    id: "sample-session-lian-tablet",
    personId: "sample-person-lian-ong",
    personName: "Lian",
    device: "Tablet",
    browser: "Safari",
    location: "Davao City",
    lastSeen: "2 hours ago",
    current: false,
  },
  {
    id: "sample-session-tomas-mobile",
    personId: "sample-person-tomas-yu",
    personName: "Tomas",
    device: "Mobile",
    browser: "Chrome",
    location: "Taguig",
    lastSeen: "3 hours ago",
    current: false,
  },
  {
    id: "sample-session-rhea-desktop",
    personId: "sample-person-rhea-dizon",
    personName: "Rhea",
    device: "Desktop",
    browser: "Firefox",
    location: "Pasig",
    lastSeen: "Yesterday",
    current: false,
  },
];
