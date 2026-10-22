import type {
  Channel as ContractChannel,
  LiveMessage,
  PresenceSnapshot,
} from "../contract/types";

/** Read-only presentation values; commands use the contract IDs and client. */
export interface Category {
  id: string;
  name: string;
  /** The department whose channels this category holds; "" holds organization channels. */
  departmentId: string;
}
export interface Channel {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  archived: boolean;
  scope: ContractChannel["scope"];
  /** The channel's department; "" for an organization channel. */
  departmentId: string;
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
  authorId: string;
  text: string;
  created: number;
  seq?: number;
  edited?: boolean;
  pinned: boolean;
  files?: LocalAttachment[];
  replyToId?: string;
  reactions?: Record<string, string[]>;
  recordId?: string;
  deleted?: boolean;
  linkPreviews?: LiveMessage["link_previews"];
  parentId?: string;
}
export interface Thread {
  id: string;
  conversation: string;
  messageId: string;
  name: string;
  locked: boolean;
  archived: boolean;
  resolved: boolean;
  replies: Message[];
  replyCount?: number;
  subscribed: boolean;
}
export interface Direct {
  id: string;
  user: string;
  read: boolean;
  blocked: boolean;
}
export function messageAuthorId(message: Message) {
  return message.authorId;
}
export function threadMessages(thread: Thread) {
  return thread.replies;
}
export type Presence = Record<
  string,
  PresenceSnapshot["items"][number]["state"]
>;
export function presenceLabel(presence: Presence, userId: string) {
  const state = presence[userId] ?? "offline";
  return state[0].toUpperCase() + state.slice(1);
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
/**
 * A new channel's draft. A category bound to a department holds only that
 * department's channels, so the draft starts there.
 */
export function newChannel(category: Category | undefined): Channel {
  return {
    id: "",
    name: "",
    description: "",
    categoryId: category?.id ?? "",
    scope: category?.departmentId ? "department" : "organization",
    departmentId: category?.departmentId ?? "",
    archived: false,
  };
}
