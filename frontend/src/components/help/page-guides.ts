type PageGuide = {
  title: string;
  entries: readonly [string, string, string, string?, string?, string?];
};

/** Canonical navigation pages; sections share their page's guide. */
export const PAGE_GUIDES = {
  sandbox: {
    title: "Sandbox",
    entries: [
      "Build: arrange departments and modules on the canvas, or pick them in Structure. With nothing selected, the Summary shows what needs attention; select an item to change it in Properties.",
      "Triggers: the list shows each trigger On or Off. Open one to set When it runs, If it checks something, and Then what it does, then choose Save triggers.",
      "Test: fill in the Setup and run it to see the Result. A result shows only while it matches the current setup.",
      "History: versions are grouped by day, with automatic saves folded. Compare puts the older version before the newer one, and Restore saves your draft as a checkpoint first.",
    ],
  },
  boards: {
    title: "Boards",
    entries: [
      "Choose a board to see the team information you can access. Company boards are shared with everyone in the organization.",
      "Posts holds updates and their history. Open a post to read it; editing controls depend on your access.",
      "Calendar shows the board's events. Open an event to see its details and available actions.",
      "Overview brings the board's information together. You can only open linked records and files that you are allowed to read.",
    ],
  },
  comms: {
    title: "OpenComms",
    entries: [
      "OpenComms reads conversations and messages from the current organization's server. Your access determines which conversations you can open.",
      "A message is sent only after the server accepts it. If it is marked Not sent, Retry keeps the original send identity and your draft stays available.",
      "People, linked records and files keep their own access checks. Opening a conversation does not grant access to everything linked from it.",
      "Administrators open channel templates, settings history, join requests, moderation, retention and export from Admin tools. Changes there are saved to your organization; retention changes and settings restores ask for your password first.",
    ],
  },
  access: {
    title: "Access",
    entries: [
      "Access shows who can see and change your organization's information. The sections you see depend on your role.",
      "Overview shows who is signed in, recent sign-ins, what needs attention and access by department. Its links open the matching list.",
      "People lists everyone in the organization, and Invite person sends an invitation. The status buttons and Filters narrow the list; open a person to change their details, groups and security.",
      "Groups give access to departments. Read opens and views, Write adds and changes records, and Manage also changes settings and who has access. Department managers change only the members of their groups.",
      "Security shows a summary of the account policy and the active sessions. Administrators change the policy in Edit policy. Your own sign-in settings are in Account settings.",
    ],
  },
  openview: {
    title: "OpenView",
    entries: [
      "Choose a record structure and a saved view to browse the records you can read.",
      "Filters, sorting, and visible columns help you find the right record. Open a record to inspect it before making a change.",
      "Dashboards and Charts summarize accessible information. A chart does not grant access to its underlying records.",
      "Reports prepares saved report results and exports. Editing and export controls depend on your access.",
    ],
  },
  manage: {
    title: "Manage",
    entries: [
      "Organization: change the name, region, and look in the two panes, then choose Save settings at the bottom. Discard changes returns to the saved values. Only administrators can change them.",
      "Audit: the quick filters show all events, changes, created, or deleted items. Filters narrows by person, area, and dates; open an event to see what changed in its event details.",
      "Backup: Status shows the schedule, the last good backup, and the backup service. History lists every backup; select one to see its details. The person who runs your server restores backups.",
      "Jobs: the state filters show Pending, Queued, Running, Failed, and other work. Open a row's menu and choose Retry when a failed job offers it.",
      "Updates & licensing: one Installation panel shows the version, the release check, and the license. The person who runs your server installs updates.",
    ],
  },
  platform: {
    title: "Platform",
    entries: [
      "Search finds the people and information you can access. Open a result only when its destination is available.",
      "Files shows accessible files. Uploads and downloads use the application's permission checks.",
      "Notifications points you to changes that matter to you. A notification does not grant new access.",
      "Import & export offers the available data-transfer actions. Review their scope before confirming a change.",
    ],
  },
  profile: {
    title: "Profile",
    entries: [
      "Your profile shows your photo, name, job title, phone, role, groups, and bio, as people in your organization see them.",
      "View profile on a person card opens that person's profile. Guests see only the photo, name, and job title.",
      "Account settings holds your profile details, sign-in, appearance, and regional preferences. Open it from your profile or the account menu.",
    ],
  },
  "account-settings": {
    title: "Account settings",
    entries: [
      "Identity holds your photo, display name, job title, phone, bio, and sign-in email. Save profile saves only the fields you changed; the photo saves at once.",
      "Sign-in holds your password, two-step verification, and your sessions.",
      "Appearance holds your color mode, reduced-motion choice, and keyboard shortcuts, and saves each choice at once. Text size and page spacing apply to this device.",
      "Regional holds your timezone and date, time, and week formats, and saves each choice at once. Organization defaults remain in Manage.",
    ],
  },
} as const satisfies Record<string, PageGuide>;

export function pageGuideForNavigation(key: string | null): PageGuide | null {
  const page = key?.split(":")[0];
  return page && Object.hasOwn(PAGE_GUIDES, page)
    ? PAGE_GUIDES[page as keyof typeof PAGE_GUIDES]
    : null;
}
