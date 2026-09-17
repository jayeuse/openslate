import type { Person } from "../../access/domain/model";

export interface Permissions {
  access: "everyone" | "roles";
  roles: string[];
  posting: "everyone" | "roles";
  postRoles: string[];
}
export interface Category extends Permissions {
  id: string;
  name: string;
}
export interface Channel extends Permissions {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  inherit: boolean;
  archived: boolean;
  system: boolean;
}
export const OPEN_PERMISSIONS: Permissions = {
  access: "everyone",
  roles: [],
  posting: "everyone",
  postRoles: [],
};
export const CATEGORIES: Category[] = [
  { id: "company", name: "Company", ...OPEN_PERMISSIONS },
  { id: "projects", name: "Projects", ...OPEN_PERMISSIONS },
];
export function permissionsFor(
  channel: Channel,
  categories: Category[],
): Permissions {
  return channel.inherit
    ? (categories.find((category) => category.id === channel.categoryId) ??
        channel)
    : channel;
}
export function hasAccess(policy: Permissions, role: string): boolean {
  return policy.access === "everyone" || policy.roles.includes(role);
}
export interface LocalAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
}
export interface Message {
  id: string;
  conversation: string;
  author: string;
  authorId?: string;
  text: string;
  created: number;
  pinned: boolean;
  attachment?: string;
  files?: LocalAttachment[];
  replyToId?: string;
  reactions?: Record<string, string[]>;
  recordId?: string;
}
export interface Thread {
  id: string;
  conversation?: string;
  messageId: string;
  resolved: boolean;
  replies: (Message | string)[];
  subscribed: boolean;
}
export interface Direct {
  id: string;
  user: string;
  read: boolean;
  blocked: boolean;
}
export interface SampleNotification {
  channelId?: string;
  messageId?: string;
  id: string;
  title: string;
  recordId?: string;
  read: boolean;
}
export interface RecordThread {
  id: string;
  recordId: string;
  text: string;
}
export const PEOPLE = ["Morgan Kim", "Alex Lee", "Jamie Torres"];
export const CHANNELS: Channel[] = [
  {
    id: "sample-channel-operations",
    name: "operations",
    description: "Daily coordination, updates, and a little team spirit.",
    categoryId: "company",
    inherit: true,
    archived: false,
    system: true,
    ...OPEN_PERMISSIONS,
  },
  {
    id: "sample-channel-workshop",
    name: "workshop",
    description: "A place to work through ideas together.",
    categoryId: "projects",
    inherit: true,
    archived: false,
    system: true,
    ...OPEN_PERMISSIONS,
  },
];
export const MESSAGES: Message[] = [
  {
    id: "sample-message-welcome",
    conversation: CHANNELS[0].id,
    author: "Alex Lee",
    text: "Morning team. Let’s keep today’s inspections moving. Share any blockers here.",
    created: Date.UTC(2026, 8, 10, 1),
    pinned: true,
  },
  {
    id: "sample-message-followup",
    conversation: CHANNELS[0].id,
    author: "Alex Lee",
    text: "The inspection checklist is pinned above. Add your findings before handover.",
    created: Date.UTC(2026, 8, 10, 1, 1),
    pinned: false,
  },
  {
    id: "sample-message-status",
    conversation: CHANNELS[0].id,
    author: "Morgan Kim",
    text: "Workshop is ready. I’m checking the pump seal replacement first.",
    created: Date.UTC(2026, 8, 10, 1, 6),
    pinned: false,
    recordId: "sample-sr-1004",
  },
  {
    id: "sample-message-checkin",
    conversation: CHANNELS[0].id,
    author: "Jamie Torres",
    text: "Thanks, Morgan. I’ll coordinate the afternoon visits and post the updated schedule here.",
    created: Date.UTC(2026, 8, 11, 1),
    pinned: false,
  },
  {
    id: "sample-message-old",
    conversation: "sample-dm-alex",
    author: "You",
    text: "Yesterday’s inspection notes are ready.",
    created: 0,
    pinned: false,
  },
];

// Older sample messages predate the viewing-person picker. Their owner stays Eli.
export function messageAuthorId(message: Message, people: Person[]): string {
  return (
    message.authorId ??
    (message.author === "You"
      ? "sample-eli"
      : (people.find((person) => person.name === message.author)?.id ??
        `sample-author-${message.author}`))
  );
}
export function threadMessages(thread: Thread): Message[] {
  return thread.replies.map((reply, index) =>
    typeof reply === "string"
      ? {
          id: `${thread.id}-reply-${index}`,
          conversation: thread.id,
          author: reply.startsWith("Alex Lee:") ? "Alex Lee" : "You",
          text: reply.replace(/^Alex Lee: /, ""),
          created: 0,
          pinned: false,
        }
      : reply,
  );
}
export function samplePresence(
  personId: string,
  viewerId: string,
  viewerPresence: string,
): string {
  if (personId === viewerId) return viewerPresence;
  return (
    (
      {
        "sample-eli": "Available",
        "sample-person-alex-lee": "Available",
        "sample-person-morgan-kim": "Busy",
        "sample-person-sofia-garcia": "Available",
        "sample-person-noah-tan": "Available",
        "sample-person-isabel-lim": "Busy",
        "sample-person-leo-mendoza": "Available",
        "sample-person-amara-flores": "Available",
        "sample-person-theo-ramos": "Busy",
        "sample-person-camille-dizon": "Available",
        "sample-person-gabriel-ong": "Available",
      } as Record<string, string>
    )[personId] ?? "Offline"
  );
}
export const EMOTES = [
  { emoji: "👍", label: "Thumbs up" },
  { emoji: "❤️", label: "Heart" },
  { emoji: "😂", label: "Laughing" },
  { emoji: "🔥", label: "Fire" },
  { emoji: "🎉", label: "Celebrate" },
  { emoji: "👀", label: "Eyes" },
  { emoji: "🙏", label: "Thanks" },
  { emoji: "✅", label: "Done" },
];
