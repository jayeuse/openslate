import type { ComponentProps } from "react";
import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import type { Person, Role } from "../../access/domain/model";
import type { LocalAttachment, Message } from "../domain/model";
import type { CommsPreferences, CommsSettings } from "../domain/configuration";

export function TextField({
  label,
  id,
  className,
  ...props
}: ComponentProps<typeof Input> & { label: string }) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <Field>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <Input {...props} id={controlId} className={cn("min-h-11", className)} />
    </Field>
  );
}
export type CommsAsyncResult =
  string | null | void | Promise<string | null | void>;
export type ThreadChangeOptions = {
  archiveMessage?: Message;
  historyMessage?: Message;
  /** Replies displayed by this render; used to merge concurrent replies. */
  replyBase?: Message[];
};

export type TimelineActions = {
  onChange: (id: string, patch: Partial<Message>) => CommsAsyncResult;
  onDelete: (id: string) => CommsAsyncResult;
  onReply: (message: Message) => void;
  onThread: (message: Message) => void;
  onJump: (id: string) => void;
  onDirect: (name: string) => void;
  onMessageTool?: (
    view: "message-history" | "report" | "outbox",
    messageId: string,
    opener: HTMLElement,
  ) => void;
};
export type TimelinePeople = {
  people: Person[];
  roles: Role[];
  viewerId: string;
  viewerPresence: string;
  elevated: boolean;
  allowDownload?: boolean;
  preferences?: CommsPreferences;
  settings?: CommsSettings;
};
export function formatFileSize(size: number): string {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
export type MessageDraft = {
  sentAt: number;
  text: string;
  files: LocalAttachment[];
  recordId: string;
};
