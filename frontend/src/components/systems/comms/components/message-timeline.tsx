import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { MessagesSquare, Paperclip, Pin, Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SampleRecord } from "../../shared/data/sample-data";
import {
  messageAuthorId,
  presenceLabel,
  type Message,
  type Thread,
} from "../domain/view-model";
import { Avatar, MessageMenu, ProfilePopover } from "./floating";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Message as MessageRow,
  MessageContent,
  MessageHeader,
} from "@/components/ui/message";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Toggle as ReactionToggle } from "@/components/ui/toggle";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { localAttachmentUrl } from "../../shared/runtime/local-attachments";
import {
  DEFAULT_COMMS_PREFERENCES,
  DEFAULT_COMMS_SETTINGS,
  type CommsSettings,
} from "../domain/configuration";
import { Action } from "../../shared/components/ui";
import {
  formatFileSize,
  TextField,
  type TimelineActions,
  type TimelinePeople,
} from "./message-shared";
import { reportCommsError } from "../state/comms-feedback";
import { recordContext, type GroupTone } from "../domain/groups";
import { useCommsClient } from "../state/client-context";

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
// The department's top edge on a record card, as on a canvas module.
const TONE_EDGE: Record<GroupTone, string> = {
  0: "shadow-[inset_0_3px_0_var(--rule-strong)]",
  1: "shadow-[inset_0_3px_0_var(--dept-1)]",
  2: "shadow-[inset_0_3px_0_var(--dept-2)]",
  3: "shadow-[inset_0_3px_0_var(--dept-3)]",
  4: "shadow-[inset_0_3px_0_var(--dept-4)]",
};

/** The table glyph of a module card on the Sandbox canvas. */
function TableGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="text-muted-foreground size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M6.5 6.5v7" />
    </svg>
  );
}

/** A record's due date in the viewer's own date format. */
export function formatDueDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function MessageTimeline({
  visibleMessages,
  allMessages,
  onOpenRecord,
  records,
  threads,
  highlightedId,
  people,
  roles,
  viewerId,
  presence = {},
  elevated,
  capabilities,
  membershipRole,
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
  onOpenRecord?: (recordId: string) => void;
  records: SampleRecord[];
  threads: Thread[];
  highlightedId?: string;
  mutable: boolean;
} & TimelinePeople &
  TimelineActions) {
  const { client } = useCommsClient();
  const lifetime = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const [editing, setEditing] = useState("");
  const [editText, setEditText] = useState("");
  // Failures show as a visible OpenComms notice (state/comms-feedback.ts).
  const setNotice = reportCommsError;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {visibleMessages.map((message, index) => {
        const authorId = messageAuthorId(message);
        const person = people.find((item) => item.id === authorId);
        const authorName = person?.name ?? message.author;
        const own = authorId === viewerId;
        const previous = visibleMessages[index - 1];
        const grouped =
          preferences.groupMessages &&
          previous &&
          messageAuthorId(previous) === authorId &&
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
              <div className="text-muted-foreground my-5 flex items-center gap-3 px-3 text-xs font-medium">
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
              label={`${authorName}, ${new Date(message.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              own={own}
              mutable={mutable && !message.deleted}
              canReact={capabilities?.react.allowed ?? false}
              canReply={capabilities?.reply.allowed ?? false}
              canCreateThread={
                !message.parentId &&
                (capabilities?.createThread.allowed ?? false)
              }
              canReport={
                membershipRole !== undefined && membershipRole !== "guest"
              }
              canEdit={own && mutable && !message.deleted}
              editExpired={
                settings.editWindowMinutes > 0 &&
                now - message.created > settings.editWindowMinutes * 60 * 1000
              }
              allowedReactions={settings.allowedReactions}
              onTool={(view, opener) =>
                onMessageTool?.(view, message.id, opener)
              }
              canElevate={elevated && mutable && !message.deleted}
              canDelete={
                mutable &&
                !message.deleted &&
                (own
                  ? settings.deleteWindowMinutes === 0 ||
                    now - message.created <=
                      settings.deleteWindowMinutes * 60 * 1000
                  : (capabilities?.deleteOthersMessages.allowed ?? false))
              }
              pinned={message.pinned}
              onReaction={(emoji) => {
                if (!mutable || !capabilities?.react.allowed) return;
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
                if (own || capabilities?.deleteOthersMessages.allowed)
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
                          presence={presenceLabel(presence, person.id)}
                          onMessage={onDirect}
                        />
                      ) : (
                        <Avatar name={authorName} />
                      ))}
                    <strong className="min-w-0 truncate text-sm">
                      {authorName}
                    </strong>
                    {preferences.timestamps !== "none" && (
                      <span className="text-muted-foreground shrink-0 text-xs">
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
                          ? `${people.find((item) => item.id === messageAuthorId(quote))?.name ?? quote.author}: ${quote.text}`
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
                    message.linkPreviews?.map((preview) => (
                      <a
                        key={preview.url}
                        href={preview.url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 block min-w-0 text-xs"
                      >
                        <Card className="w-full">
                          <CardContent className="p-3">
                            <strong>{preview.title}</strong>
                            <p>{preview.description}</p>
                            <p className="text-muted-foreground">
                              {preview.site_name}
                            </p>
                          </CardContent>
                        </Card>
                      </a>
                    ))}
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
                          {formatFileSize(file.size)} · Local sample attachment
                        </AttachmentDescription>
                        {!settings.fileDownloads || !allowDownload ? (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Downloads disabled by channel policy.
                          </p>
                        ) : (
                          <button
                            type="button"
                            className="mt-1 inline-flex min-h-9 items-center text-xs underline"
                            disabled={!client || downloading === file.id}
                            onClick={async () => {
                              const signal = lifetime.current?.signal;
                              if (!client || !signal || signal.aborted) return;
                              setDownloading(file.id);
                              try {
                                const download =
                                  await client.downloadAttachment(
                                    message.conversation,
                                    file.id,
                                    { signal },
                                  );
                                await client.bootstrap({ signal });
                                const url = URL.createObjectURL(download.bytes);
                                try {
                                  const anchor = document.createElement("a");
                                  anchor.href = url;
                                  anchor.download = download.filename;
                                  anchor.click();
                                } finally {
                                  URL.revokeObjectURL(url);
                                }
                              } catch {
                                setNotice(
                                  "The attachment could not be downloaded. Local file bytes are unavailable after reload.",
                                );
                              } finally {
                                setDownloading(null);
                              }
                            }}
                          >
                            Download {file.name}
                          </button>
                        )}
                      </AttachmentContent>
                    </Attachment>
                  ))}
                  {message.recordId &&
                    preferences.previews &&
                    (() => {
                      const record = records.find(
                        (item) => item.id === message.recordId,
                      );
                      const title = record?.title ?? "Linked record";
                      const { module, group } = recordContext(record);
                      return (
                        <div
                          className={cn(
                            "border-card-edge bg-card mt-2 max-w-md overflow-hidden rounded-[calc(var(--radius)*1.25)] border",
                            TONE_EDGE[group?.tone ?? 0],
                          )}
                        >
                          <div className="flex items-center gap-2 border-b pr-3">
                            <button
                              type="button"
                              onClick={() => onOpenRecord?.(message.recordId!)}
                              className="hover:bg-muted focus-visible:outline-ring flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 px-3 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 sm:flex-nowrap"
                            >
                              <span className="sr-only">Open record: </span>
                              <TableGlyph />
                              <span className="text-muted-foreground order-first w-full text-xs sm:order-none sm:w-auto sm:shrink-0">
                                {group ? `${group.name} › ` : ""}
                                {module}
                              </span>
                              {record && (
                                <span className="truncate text-sm font-semibold">
                                  {title}
                                </span>
                              )}
                            </button>
                            <Link
                              href={`/openview?record=${encodeURIComponent(message.recordId)}`}
                              aria-label={`Open in OpenView: ${title}`}
                              className="text-action-text shrink-0 text-xs font-semibold hover:underline"
                            >
                              Open in OpenView
                            </Link>
                          </div>
                          {!!record?.fields?.length && (
                            <dl className="grid grid-cols-2 sm:grid-cols-3">
                              {record.fields.map((field) => (
                                <div
                                  key={field.id}
                                  className="min-w-0 border-r px-3 py-2 last:border-r-0"
                                >
                                  <dt className="text-muted-foreground text-xs">
                                    {field.label}
                                  </dt>
                                  <dd
                                    className={cn(
                                      "truncate text-xs",
                                      // Code font is for data: dates.
                                      field.label === "Due date" &&
                                        "font-mono tabular-nums",
                                    )}
                                  >
                                    {field.displayValue}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      );
                    })()}
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
                            !capabilities?.react.allowed ||
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
                      {thread.resolved ? " · Resolved" : ""}
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
