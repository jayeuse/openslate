import type {
  Channel as ContractChannel,
  LiveMessage,
  PresenceSnapshot,
} from "../contract/types";

/** Read-only presentation values; commands use the contract IDs and client. */
export type GroupAccessLevel = "none" | "read" | "post";
export interface Category {
  id: string;
  name: string;
  groupId?: string;
}
export interface Channel {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  archived: boolean;
  scope: ContractChannel["scope"];
  groupAccess?: Record<string, GroupAccessLevel>;
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
export function newChannel(categoryId: string): Channel {
  return {
    id: "",
    name: "",
    description: "",
    categoryId,
    scope: "groups",
    archived: false,
  };
}
