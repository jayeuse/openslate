import type { Person, Role } from "../access/model";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  Pin,
  Paperclip,
  X,
  Send,
  Reply,
  Check,
  MessagesSquare,
  Settings2,
  LinkIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SampleRecord } from "../sample-data";
import {
  messageAuthorId,
  samplePresence,
  threadMessages,
  type LocalAttachment,
  type Message,
  type Thread,
} from "./model";
import { Avatar, EmojiPicker, MessageMenu, ProfilePopover } from "./floating";
export { Avatar } from "./floating";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Card, CardContent } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Message as MessageRow,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment";
import { Field, FieldLabel } from "@/components/ui/field";
import { Toggle as ReactionToggle } from "@/components/ui/toggle";
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
} from "@/components/ui/message-scroller";

import { useSampleRuntime, useSampleState } from "../sample-state";
import { useCommsDraftText, legacyCommsDraftTextKey } from "./draft-text";
import {
  cacheLocalAttachment,
  localAttachmentUrl,
  releaseLocalAttachment,
} from "./local-attachments";
import {
  DEFAULT_COMMS_PREFERENCES,
  DEFAULT_COMMS_SETTINGS,
  type CommsPreferences,
  type CommsSettings,
} from "./configuration";
import { Action, Choice, Toggle } from "../ui";

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
function MessageText({
  text,
  settings,
}: {
  text: string;
  settings: CommsSettings;
}) {
  if (!settings.formatting) return text;
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s]+)/g)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={index} className="bg-muted rounded px-1">
          {part.slice(1, -1)}
        </code>
      ) : /^https?:\/\//.test(part) ? (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          {part}
        </a>
      ) : (
        part
      ),
    );
}
export function MessageTimeline({
  visibleMessages,
  allMessages,
  records,
  threads,
  highlightedId,
  people,
  roles,
  viewerId,
  viewerPresence,
  elevated,
  allowDownload = true,
  preferences = DEFAULT_COMMS_PREFERENCES,
  settings = DEFAULT_COMMS_SETTINGS,
  mutable,
  onChange,
  onDelete,
  onReply,
  onThread,
  onJump,
  onDirect,
  onMessageTool,
}: {
  visibleMessages: Message[];
  allMessages: Message[];
  records: SampleRecord[];
  threads: Thread[];
  highlightedId?: string;
  mutable: boolean;
} & TimelinePeople &
  TimelineActions) {
  const [editing, setEditing] = useState("");
  const [editText, setEditText] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {visibleMessages.map((message, index) => {
        const authorId = messageAuthorId(message, people);
        const person = people.find((item) => item.id === authorId);
        const authorName = person?.name ?? message.author;
        const own = authorId === viewerId;
        const previous = visibleMessages[index - 1];
        const grouped =
          preferences.groupMessages &&
          previous &&
          messageAuthorId(previous, people) === authorId &&
          Math.abs(message.created - previous.created) < 5 * 60 * 1000;
        const newDay =
          !previous ||
          new Date(previous.created).toDateString() !==
            new Date(message.created).toDateString();
        const quote = allMessages.find((item) => item.id === message.replyToId);
        const thread = threads.find((item) => item.messageId === message.id);
        return (
          <MessageScrollerItem
            key={message.id}
            messageId={message.id}
            className="[content-visibility:visible]"
          >
            {newDay && (
              <div className="text-muted-foreground my-5 flex items-center gap-3 px-3 text-[10px] font-medium">
                <Separator className="flex-1" />
                {message.created
                  ? new Date(message.created).toLocaleDateString([], {
                      month: "long",
                      day: "numeric",
                    })
                  : "Earlier"}
                <Separator className="flex-1" />
              </div>
            )}
            <MessageMenu
              id={message.id}
              highlighted={highlightedId === message.id}
              className={cn(
                "hover:bg-muted/40 px-3",
                preferences.density === "compact" ? "py-0.5" : "py-1.5",
                !grouped && "mt-3",
              )}
              mutable={mutable}
              canEdit={own && mutable}
              editExpired={
                settings.editWindowMinutes > 0 &&
                now - message.created > settings.editWindowMinutes * 60 * 1000
              }
              allowedReactions={settings.allowedReactions}
              onTool={(view, opener) =>
                onMessageTool?.(view, message.id, opener)
              }
              canElevate={elevated && mutable}
              canDelete={
                (own || elevated) &&
                mutable &&
                (settings.deleteWindowMinutes === 0 ||
                  now - message.created <=
                    settings.deleteWindowMinutes * 60 * 1000)
              }
              pinned={message.pinned}
              onReaction={(emoji) => {
                if (!mutable) return;
                const current = message.reactions?.[emoji] ?? [];
                const next = current.includes(viewerId)
                  ? current.filter((id) => id !== viewerId)
                  : [...current, viewerId];
                void Promise.resolve(
                  onChange(message.id, {
                    reactions: { ...message.reactions, [emoji]: next },
                  }),
                ).then((error) => {
                  if (error) setNotice(error);
                });
              }}
              onEdit={() => {
                setEditing(message.id);
                setEditText(message.text);
              }}
              onReply={() => onReply(message)}
              onThread={() => onThread(message)}
              onPin={() => {
                if (elevated)
                  void Promise.resolve(
                    onChange(message.id, { pinned: !message.pinned }),
                  ).then((error) => {
                    if (error) setNotice(error);
                  });
              }}
              onDelete={() => {
                if (own || elevated)
                  void Promise.resolve(onDelete(message.id)).then((error) => {
                    if (error) setNotice(error);
                  });
              }}
            >
              <MessageRow className="flex-col gap-0">
                {!grouped && (
                  <MessageHeader className="text-foreground mb-1 gap-3 px-0 pr-8">
                    {preferences.avatars &&
                      (person ? (
                        <ProfilePopover
                          person={person}
                          roleName={
                            roles.find((role) => role.id === person.role)
                              ?.name ?? "Unassigned"
                          }
                          presence={samplePresence(
                            person.id,
                            viewerId,
                            viewerPresence,
                          )}
                          onMessage={onDirect}
                        />
                      ) : (
                        <Avatar name={authorName} />
                      ))}
                    <strong className="min-w-0 truncate text-sm">
                      {authorName}
                    </strong>
                    {preferences.timestamps !== "none" && (
                      <span className="text-muted-foreground shrink-0 text-[10px]">
                        {message.created
                          ? new Date(message.created)[
                              preferences.timestamps === "full"
                                ? "toLocaleString"
                                : "toLocaleTimeString"
                            ]([], {
                              ...(preferences.timestamps === "full"
                                ? ({
                                    year: "numeric",
                                    month: "short",
                                    day: "numeric",
                                  } as const)
                                : {}),
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Earlier"}
                      </span>
                    )}
                    {message.pinned && (
                      <Pin aria-label="Pinned" className="size-3 shrink-0" />
                    )}
                  </MessageHeader>
                )}
                <MessageContent
                  className={cn("gap-0 pr-5", preferences.avatars && "pl-11")}
                >
                  {message.replyToId && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground mb-1 h-auto min-h-7 w-full justify-start px-0 text-left text-xs"
                      onClick={() => {
                        if (message.replyToId) onJump(message.replyToId);
                      }}
                    >
                      <Reply className="size-3 shrink-0" />
                      <span className="truncate">
                        {quote
                          ? `${people.find((item) => item.id === messageAuthorId(quote, people))?.name ?? quote.author}: ${quote.text}`
                          : "Original message unavailable"}
                      </span>
                    </Button>
                  )}
                  {editing === message.id && own && mutable ? (
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (
                          !mutable ||
                          !own ||
                          (settings.editWindowMinutes > 0 &&
                            Date.now() - message.created >
                              settings.editWindowMinutes * 60 * 1000)
                        ) {
                          setNotice("The configured edit window has ended.");
                          setEditing("");
                          return;
                        }
                        if (!editText.trim()) return;
                        try {
                          const error = await onChange(message.id, {
                            text: editText.trim(),
                          });
                          if (error) {
                            setNotice(error);
                            return;
                          }
                        } catch {
                          setNotice(
                            "The message could not be saved. Try again.",
                          );
                          return;
                        }
                        setEditing("");
                      }}
                    >
                      <TextField
                        label="Edit message"
                        value={editText}
                        onChange={(event) => setEditText(event.target.value)}
                        required
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Action type="submit" size="sm">
                          Save message
                        </Action>
                        <Action
                          type="button"
                          size="sm"
                          onClick={() => setEditing("")}
                        >
                          Cancel edit
                        </Action>
                      </div>
                    </form>
                  ) : (
                    <p
                      className={cn(
                        "leading-6 break-words whitespace-pre-wrap",
                        preferences.textSize === "small"
                          ? "text-xs"
                          : preferences.textSize === "large"
                            ? "text-base"
                            : "text-sm",
                      )}
                    >
                      <MessageText text={message.text} settings={settings} />
                    </p>
                  )}
                  {settings.linkPreviews &&
                    preferences.previews &&
                    message.text.match(/https?:\/\/[^\s]+/) && (
                      <a
                        href={message.text.match(/https?:\/\/[^\s]+/)![0]}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 block min-w-0 text-xs"
                      >
                        <Card className="w-full">
                          <CardContent className="truncate p-3">
                            Link preview ·{" "}
                            {message.text.match(/https?:\/\/[^\s]+/)![0]}
                          </CardContent>
                        </Card>
                      </a>
                    )}
                  {message.attachment && (
                    <Attachment className="mt-2" size="sm">
                      <AttachmentMedia>
                        <Paperclip />
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle>{message.attachment}</AttachmentTitle>
                      </AttachmentContent>
                    </Attachment>
                  )}
                  {message.files?.map((file) => (
                    <Attachment key={file.id} className="bg-muted/20 mt-2">
                      <AttachmentMedia
                        className={cn(
                          settings.filePreviews &&
                            preferences.previews &&
                            file.type.startsWith("image/") &&
                            localAttachmentUrl(file.id) &&
                            "w-20",
                        )}
                      >
                        {settings.filePreviews &&
                        preferences.previews &&
                        file.type.startsWith("image/") &&
                        localAttachmentUrl(file.id) ? (
                          <Image
                            src={localAttachmentUrl(file.id)!}
                            alt={`Preview of ${file.name}`}
                            width={96}
                            height={96}
                            unoptimized
                            className="size-20 rounded object-cover"
                          />
                        ) : (
                          <Paperclip className="text-muted-foreground size-4 shrink-0" />
                        )}
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle>{file.name}</AttachmentTitle>
                        <AttachmentDescription className="whitespace-normal">
                          {formatFileSize(file.size)} · Local file, not uploaded
                        </AttachmentDescription>
                        {!settings.fileDownloads || !allowDownload ? (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Downloads disabled by channel policy.
                          </p>
                        ) : localAttachmentUrl(file.id) ? (
                          <a
                            className="mt-1 inline-flex min-h-9 items-center text-xs underline"
                            href={localAttachmentUrl(file.id)}
                            download={file.name}
                          >
                            Download {file.name}
                          </a>
                        ) : (
                          <p className="text-muted-foreground mt-1 text-xs">
                            File contents unavailable after reload.
                          </p>
                        )}
                      </AttachmentContent>
                    </Attachment>
                  ))}
                  {message.recordId && preferences.previews && (
                    <Link
                      href={`/openview?record=${encodeURIComponent(message.recordId)}`}
                      className="mt-2 block text-sm"
                    >
                      <Card className="hover:bg-muted w-full">
                        <CardContent className="p-3">
                          <span className="text-muted-foreground mb-1 block text-[10px] font-semibold tracking-wider uppercase">
                            OpenView · linked record
                          </span>
                          <span className="underline underline-offset-4">
                            {settings.recordCardFields.includes("title")
                              ? (records.find(
                                  (record) => record.id === message.recordId,
                                )?.title ?? "View record")
                              : "View linked record"}
                          </span>
                          {settings.recordCardFields
                            .filter((field) => field !== "title")
                            .map((field) => (
                              <span className="mt-1 block text-xs" key={field}>
                                {field}:{" "}
                                {String(
                                  records.find(
                                    (record) => record.id === message.recordId,
                                  )?.[field as keyof SampleRecord] ?? "—",
                                )}
                              </span>
                            ))}
                        </CardContent>
                      </Card>
                    </Link>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(message.reactions ?? {})
                      .filter(([, users]) => users.length)
                      .map(([emoji, users]) => (
                        <ReactionToggle
                          type="button"
                          variant="outline"
                          key={emoji}
                          aria-label={`${emoji} ${users.length}`}
                          pressed={users.includes(viewerId)}
                          disabled={
                            !mutable ||
                            !settings.allowedReactions.includes(emoji)
                          }
                          onPressedChange={(pressed) =>
                            void Promise.resolve(
                              onChange(message.id, {
                                reactions: {
                                  ...message.reactions,
                                  [emoji]: pressed
                                    ? [...users, viewerId]
                                    : users.filter((id) => id !== viewerId),
                                },
                              }),
                            ).then((error) => {
                              if (error) setNotice(error);
                            })
                          }
                          className="mt-2 min-h-8 gap-1.5 rounded-full text-xs"
                        >
                          <span>{emoji}</span>
                          <span>{users.length}</span>
                        </ReactionToggle>
                      ))}
                  </div>
                  {thread && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground mt-1 h-auto min-h-8 justify-start px-0 text-xs"
                      onClick={() => onThread(message)}
                    >
                      <MessagesSquare className="size-3" />
                      {thread.replies.length} replies
                      {thread.resolved ? " · Inactive" : ""}
                    </Button>
                  )}
                </MessageContent>
              </MessageRow>
            </MessageMenu>
          </MessageScrollerItem>
        );
      })}
    </>
  );
}

export function MembersPanel({
  members,
  roles,
  viewerId,
  viewerPresence,
  onClose,
  onDirect,
}: {
  members: Person[];
  roles: Role[];
  viewerId: string;
  viewerPresence: string;
  onClose: () => void;
  onDirect: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = members.filter((person) =>
    person.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section
      role="region"
      aria-label="Members with access"
      className="flex flex-col gap-3 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Members{" "}
          <span className="text-muted-foreground">{members.length}</span>
        </h3>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Close members"
          onClick={onClose}
        >
          <X className="size-4" />
        </Action>
      </div>
      <Input
        aria-label="Search members"
        placeholder="Find a member"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {([false, true] as const).map((offline) => {
        const group = filtered.filter(
          (person) =>
            (samplePresence(person.id, viewerId, viewerPresence) ===
              "Offline") ===
            offline,
        );
        return (
          <section key={String(offline)} className="mt-2">
            <h4 className="text-muted-foreground mb-2 text-[10px] font-semibold tracking-wider uppercase">
              {offline ? "Offline" : "Online"}
              <span aria-hidden="true"> — {group.length}</span>
            </h4>
            <div className="flex flex-col gap-1">
              {group.map((person) => (
                <ProfilePopover
                  key={person.id}
                  person={person}
                  roleName={
                    roles.find((role) => role.id === person.role)?.name ??
                    "Unassigned"
                  }
                  presence={samplePresence(person.id, viewerId, viewerPresence)}
                  onMessage={onDirect}
                  className={cn(
                    "hover:bg-muted min-h-12 w-full gap-3 px-1.5 py-1",
                    offline && "text-muted-foreground",
                  )}
                >
                  <Avatar
                    name={person.name}
                    presence={samplePresence(
                      person.id,
                      viewerId,
                      viewerPresence,
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {person.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-[10px]">
                      {roles.find((role) => role.id === person.role)?.name ??
                        "Unassigned"}{" "}
                      · {samplePresence(person.id, viewerId, viewerPresence)}
                    </span>
                  </span>
                </ProfilePopover>
              ))}
            </div>
          </section>
        );
      })}
      {!filtered.length && (
        <Empty className="p-3">
          <EmptyDescription>No members match.</EmptyDescription>
        </Empty>
      )}
    </section>
  );
}

export function ThreadPanel({
  thread,
  message,
  allMessages,
  highlightedId,
  onJump,
  records,
  canPost,
  onClose,
  onChange,
  onThread,
  onDirect,
  threadName,
  archived = false,
  validateDraft,
  onSettings,
  onMessageTool,
  pending = false,
  ...identity
}: {
  thread: Thread;
  threadName?: string;
  archived?: boolean;
  validateDraft?: (draft: MessageDraft) => string | null;
  onSettings?: (opener: HTMLElement) => void;
  onMessageTool?: TimelineActions["onMessageTool"];
  pending?: boolean;
  message?: Message;
  allMessages: Message[];
  highlightedId: string;
  onJump: (id: string) => void;
  records: SampleRecord[];
  canPost: boolean;
  onClose: () => void;
  onChange: (
    patch: Partial<Thread>,
    options?: ThreadChangeOptions,
  ) => CommsAsyncResult;
  onThread: (message: Message) => void;
  onDirect: (name: string) => void;
} & TimelinePeople) {
  const [replyingTo, setReplyingTo] = useSampleState<Message | null>(
    `comms-thread-reply-${thread.id}`,
    null,
  );
  const list = useRef<HTMLDivElement>(null);
  const replies = threadMessages(thread);
  const [notice, setNotice] = useState("");
  async function send(draft: MessageDraft): Promise<string | null> {
    if (!canPost || thread.resolved) return "This thread is read-only.";
    const error = validateDraft?.(draft);
    if (error) return error;
    const person = identity.people.find(
      (item) => item.id === identity.viewerId,
    );
    const result = await onChange({
      replies: [
        ...replies,
        {
          id: `sample-reply-${crypto.randomUUID()}`,
          conversation: thread.id,
          author: person?.name ?? "You",
          authorId: identity.viewerId,
          text: draft.text.trim() || "Shared a file",
          created: draft.sentAt,
          pinned: false,
          files: draft.files,
          recordId: draft.recordId || undefined,
          replyToId: replyingTo?.id,
        },
      ],
    });
    if (result) return result;
    setReplyingTo(null);
    requestAnimationFrame(() =>
      list.current?.scrollTo({ top: list.current.scrollHeight }),
    );
    return null;
  }
  return (
    <section
      role="region"
      aria-label="Thread conversation"
      className="flex h-full min-h-0 flex-col"
    >
      <p role="status" className="sr-only">
        {notice}
      </p>
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4">
        <MessagesSquare className="size-4" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {threadName || "Thread"}
        </h3>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Thread settings"
          onClick={(event) => onSettings?.(event.currentTarget)}
          disabled={pending}
        >
          <Settings2 className="size-4" />
        </Action>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Copy thread link"
          onClick={() => {
            void navigator.clipboard.writeText(
              `${window.location.origin}/comms?conversation=${encodeURIComponent(thread.conversation ?? message?.conversation ?? "")}&thread=${encodeURIComponent(thread.id)}`,
            );
          }}
        >
          <LinkIcon className="size-4" />
        </Action>
        <Action
          size="sm"
          variant="ghost"
          disabled={archived || pending}
          aria-label={thread.resolved ? "Reopen thread" : "Resolve thread"}
          onClick={() => {
            void Promise.resolve(onChange({ resolved: !thread.resolved })).then(
              (error) => {
                if (error) setNotice(error);
              },
            );
          }}
        >
          {thread.resolved ? "Reopen" : <Check className="size-4" />}
        </Action>
        <Action
          variant="ghost"
          size="icon"
          aria-label="Back to messages"
          onClick={onClose}
          disabled={pending}
        >
          <X className="size-4" />
        </Action>
      </header>
      <div className="bg-muted/20 shrink-0 border-b px-4 py-3">
        <p className="text-xs font-medium">
          {message?.author === "You"
            ? identity.people.find((person) => person.id === "sample-eli")?.name
            : message?.author}
        </p>
        <p className="text-muted-foreground mt-1 line-clamp-3 text-xs leading-5">
          {message?.text}
        </p>
        {thread.resolved && (
          <Badge className="mt-2">{archived ? "Archived" : "Resolved"}</Badge>
        )}
      </div>
      <MessageScrollerProvider autoScroll={false} defaultScrollPosition="start">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport ref={list} aria-label="Thread messages">
            <MessageScrollerContent className="gap-0 pb-4">
              <MessageTimeline
                visibleMessages={replies}
                allMessages={[...allMessages, ...replies]}
                records={records}
                threads={[]}
                highlightedId={highlightedId}
                mutable={canPost && !pending}
                {...identity}
                onMessageTool={onMessageTool}
                onChange={(id, patch) => {
                  const original = replies.find((item) => item.id === id);
                  return onChange(
                    {
                      replies: replies.map((item) =>
                        item.id === id ? { ...item, ...patch } : item,
                      ),
                    },
                    {
                      ...(original && patch.text !== undefined
                        ? { historyMessage: original }
                        : {}),
                      replyBase: replies,
                    },
                  );
                }}
                onDelete={(id) => {
                  const original = replies.find((item) => item.id === id);
                  return onChange(
                    {
                      replies: replies.filter((item) => item.id !== id),
                    },
                    {
                      ...(original ? { archiveMessage: original } : {}),
                      replyBase: replies,
                    },
                  );
                }}
                onReply={(item) => {
                  setReplyingTo(item);
                  requestAnimationFrame(() =>
                    document.getElementById(`composer-${thread.id}`)?.focus(),
                  );
                }}
                onThread={onThread}
                onJump={onJump}
                onDirect={onDirect}
              />
              {!replies.length && (
                <Empty className="px-5 py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessagesSquare />
                    </EmptyMedia>
                    <EmptyTitle>Keep the details here</EmptyTitle>
                    <EmptyDescription>
                      Replies stay together in this thread.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      <Collapsible className="text-muted-foreground shrink-0 border-t px-4 py-2 text-xs">
        <CollapsibleTrigger
          render={<Button variant="ghost" size="sm" className="px-0" />}
        >
          Thread notifications
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Toggle
            control="switch"
            label="Notify me of new replies"
            checked={thread.subscribed}
            disabled={pending}
            onCheckedChange={(checked) => {
              void Promise.resolve(onChange({ subscribed: checked })).then(
                (error) => {
                  if (error) setNotice(error);
                },
              );
            }}
          />
        </CollapsibleContent>
      </Collapsible>
      <MessageComposer
        key={thread.id}
        id={thread.id}
        preferences={identity.preferences}
        settings={identity.settings}
        label="Thread reply"
        sendLabel="Send reply"
        canPost={canPost && !thread.resolved}
        conversationName="this thread"
        unavailableReason={
          archived
            ? "This thread is archived. Restore it in thread settings to reply."
            : thread.resolved
              ? "This thread is resolved. Reopen it to reply."
              : "Your role cannot post in this thread."
        }
        records={records}
        replyingTo={replyingTo}
        people={identity.people}
        onCancelReply={() => setReplyingTo(null)}
        onSend={send}
        pending={pending}
      />
    </section>
  );
}

function formatFileSize(size: number): string {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
type FilePreview = LocalAttachment & { previewUrl?: string };
export type MessageDraft = {
  sentAt: number;
  text: string;
  files: LocalAttachment[];
  recordId: string;
};
export function MessageComposer({
  id,
  label = "Message",
  sendLabel = "Send message",
  canPost,
  conversationName,
  unavailableReason,
  records,
  replyingTo,
  people,
  onCancelReply,
  onSend,
  pending = false,
  preferences = DEFAULT_COMMS_PREFERENCES,
  settings = DEFAULT_COMMS_SETTINGS,
}: {
  id: string;
  label?: string;
  sendLabel?: string;
  canPost: boolean;
  conversationName: string;
  unavailableReason: string;
  records: SampleRecord[];
  replyingTo: Message | null;
  people: Person[];
  onCancelReply: () => void;
  onSend: (draft: MessageDraft) => string | null | Promise<string | null>;
  pending?: boolean;
  preferences?: CommsPreferences;
  settings?: CommsSettings;
}) {
  const runtime = useSampleRuntime();
  const legacyKey = legacyCommsDraftTextKey(id);
  const legacyValue = runtime.read(legacyKey, "");
  const removeLegacy = useCallback(
    () =>
      runtime.execute(
        (draft) => {
          draft.remove(legacyKey);
        },
        { keys: [legacyKey] },
      ),
    [legacyKey, runtime],
  );
  const [text, setText, draftText] = useCommsDraftText(
    id,
    legacyValue,
    removeLegacy,
  );
  const [savedFiles, setSavedFiles] = useSampleState<FilePreview[]>(
    `comms-draft-files-${id}`,
    [],
  );
  const files = savedFiles.map((file) => ({
    ...file,
    previewUrl: file.type.startsWith("image/")
      ? localAttachmentUrl(file.id)
      : undefined,
  }));
  function setFiles(
    action: FilePreview[] | ((current: FilePreview[]) => FilePreview[]),
  ) {
    setSavedFiles((current) =>
      (typeof action === "function" ? action(current) : action).map(
        ({ id, name, size, type }) => ({ id, name, size, type }),
      ),
    );
  }
  const [recordId, setRecordId] = useSampleState(
    `comms-draft-record-${id}`,
    "",
  );
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [recordPickerOpen, setRecordPickerOpen] = useState(false);
  const fileInputId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const restoreComposerFocus = useRef(false);
  const isPending = sending || pending;
  useEffect(() => {
    if (isPending || !restoreComposerFocus.current) return;
    restoreComposerFocus.current = false;
    const input = textarea.current;
    if (
      document.activeElement === document.body ||
      input?.form?.contains(document.activeElement)
    )
      input?.focus();
  }, [isPending]);
  function removeFile(id: string) {
    releaseLocalAttachment(id);
    setFiles((items) => items.filter((file) => file.id !== id));
  }
  return (
    <form
      aria-label={`${label} composer`}
      className="shrink-0 border-t p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          isPending ||
          !canPost ||
          (!text.trim() && !files.length && !recordId)
        )
          return;
        const submittedTextRevision = draftText.revision;
        restoreComposerFocus.current = true;
        setSending(true);
        try {
          const error = await onSend({
            sentAt: Math.round(performance.timeOrigin + event.timeStamp),
            text,
            files: files.map(({ id, name, size, type }) => ({
              id,
              name,
              size,
              type,
            })),
            recordId,
          });
          if (error) {
            setError(error);
            return;
          }
          setError("");
          const cleared = await draftText.clear(submittedTextRevision);
          if (!cleared) return;
          setFiles([]);
          setRecordId("");
          setRecordPickerOpen(false);
        } catch {
          setError(
            "The message could not be sent. Your draft is still available.",
          );
        } finally {
          setSending(false);
        }
      }}
    >
      {error && (
        <Alert role="alert" variant="destructive" className="mb-2 p-2 text-xs">
          {error}
        </Alert>
      )}
      {draftText.storageUnavailable && (
        <p role="status" className="text-muted-foreground mb-2 text-xs">
          Draft text cannot be saved in this browser. It will remain available
          until this composer is closed.
        </p>
      )}
      {!canPost && (
        <Alert className="mb-2 p-2 text-xs">{unavailableReason}</Alert>
      )}
      {replyingTo && (
        <div className="bg-muted/50 mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs">
          <Reply className="size-3 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              Replying to{" "}
              {people.find(
                (person) => person.id === messageAuthorId(replyingTo, people),
              )?.name ?? replyingTo.author}
            </p>
            <p className="text-muted-foreground truncate">{replyingTo.text}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cancel reply"
            onClick={onCancelReply}
            disabled={isPending}
          >
            <X className="size-3" />
          </Button>
        </div>
      )}
      {recordPickerOpen && (
        <div className="mb-3">
          <Choice
            label="Attach record link"
            value={recordId}
            onChange={(event) => setRecordId(event.target.value)}
            disabled={isPending}
          >
            <option value="">No record</option>
            {records.map((record) => (
              <option key={record.id} value={record.id}>
                {record.title}
              </option>
            ))}
          </Choice>
        </div>
      )}
      {(files.length > 0 || recordId) && (
        <AttachmentGroup className="mb-2 max-h-40 flex-wrap gap-2 overflow-y-auto">
          {files.map((file) => (
            <Attachment key={file.id} size="sm" className="bg-muted/20">
              <AttachmentMedia>
                {file.previewUrl &&
                settings.filePreviews &&
                preferences.previews ? (
                  <Image
                    src={file.previewUrl}
                    alt={`Preview of ${file.name}`}
                    width={48}
                    height={48}
                    unoptimized
                    className="size-12 rounded object-cover"
                  />
                ) : (
                  <Paperclip className="text-muted-foreground size-5 shrink-0" />
                )}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle className="max-w-40">
                  {file.name}
                </AttachmentTitle>
                <AttachmentDescription>
                  {formatFileSize(file.size)} · Local preview
                </AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeFile(file.id)}
                  disabled={isPending}
                >
                  <X className="size-3" />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
          {recordId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-w-full"
              aria-label="Remove record attachment"
              onClick={() => setRecordId("")}
              disabled={isPending}
            >
              <span className="truncate">
                {records.find((record) => record.id === recordId)?.title}
              </span>
              <X className="size-3 shrink-0" />
            </Button>
          )}
        </AttachmentGroup>
      )}
      <InputGroup className="bg-muted/30 has-disabled:bg-muted/30 dark:has-disabled:bg-muted/30 has-disabled:opacity-100">
        <InputGroupTextarea
          id={`composer-${id}`}
          ref={textarea}
          aria-label={label}
          rows={2}
          className="max-h-32 min-h-12 resize-none"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (preferences.sendShortcut === "enter"
                ? !event.shiftKey
                : event.ctrlKey || event.metaKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={!canPost || isPending}
          placeholder={`Message ${conversationName}…`}
        />
        <InputGroupAddon align="block-end" className="gap-1">
          <Input
            id={fileInputId}
            type="file"
            multiple
            accept={settings.allowedFileTypes.join(",")}
            aria-label="Upload files"
            className="sr-only"
            disabled={!canPost || isPending}
            onChange={(event) => {
              const chosen = Array.from(event.target.files ?? []).map(
                (file): FilePreview => {
                  const id = crypto.randomUUID();
                  const url = cacheLocalAttachment(id, file);
                  const previewUrl = file.type.startsWith("image/")
                    ? url
                    : undefined;
                  return {
                    id,
                    name: file.name,
                    size: file.size,
                    type: file.type,
                    previewUrl,
                  };
                },
              );
              setFiles((items) => [...items, ...chosen]);
              event.target.value = "";
            }}
          />
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Choose files"
            disabled={!canPost || isPending}
            onClick={() => document.getElementById(fileInputId)?.click()}
          >
            <Paperclip className="size-4" />
          </InputGroupButton>
          <EmojiPicker
            disabled={!canPost || isPending}
            onSelect={(emoji) => {
              setText((value) => `${value}${emoji}`);
              requestAnimationFrame(() => textarea.current?.focus());
            }}
          />
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Attach record"
            disabled={!canPost || isPending}
            aria-expanded={recordPickerOpen}
            onClick={() => setRecordPickerOpen(!recordPickerOpen)}
          >
            <span className="text-base" aria-hidden="true">
              ↗
            </span>
          </InputGroupButton>
          <span className="text-muted-foreground ml-auto text-[10px]">
            {preferences.sendShortcut === "ctrl-enter"
              ? "Ctrl + Enter to send"
              : "Enter to send"}
          </span>
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            aria-label={sendLabel}
            disabled={
              !canPost ||
              isPending ||
              (!text.trim() && !files.length && !recordId)
            }
          >
            <Send className="size-4" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
