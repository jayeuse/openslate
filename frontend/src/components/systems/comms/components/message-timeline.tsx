import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  MessagesSquare,
  Paperclip,
  Pin,
  Reply,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SampleRecord } from "../../shared/data/sample-data";
import {
  messageAuthorId,
  samplePresence,
  type CommsFlow,
  type Message,
  type Thread,
} from "../domain/model";
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
import {
  commsGroup,
  recordContext,
  recordNumber,
  type GroupTone,
} from "../domain/groups";
import { GroupMark } from "./group-mark";

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

/** A handoff between groups, drawn with the canvas's own line and arrow. */
function FlowRow({
  flow,
  records,
}: {
  flow: CommsFlow;
  records: SampleRecord[];
}) {
  const from = commsGroup(flow.from);
  const to = commsGroup(flow.to);
  const record = records.find((item) => item.id === flow.recordId);
  return (
    <div
      role="note"
      aria-label={`Handoff from ${from?.name ?? flow.from} to ${to?.name ?? flow.to}`}
      className="my-3 flex items-center gap-3 px-3"
    >
      <span className="text-muted-foreground grid w-9 shrink-0 place-items-center">
        <ArrowRight aria-hidden="true" className="size-4" />
      </span>
      <div className="bg-background flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[calc(var(--radius)*1.25)] px-3 py-2 text-sm shadow-[inset_0_0_0_1px_var(--border)]">
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <GroupMark tone={from?.tone ?? 0} />
          {from?.name ?? flow.from}
        </span>
        <svg
          viewBox="0 0 48 12"
          aria-hidden="true"
          className="h-3 w-12 shrink-0 text-[color:var(--canvas-edge)]"
        >
          <path d="M1 6h41" stroke="currentColor" strokeWidth="1.6" />
          <path d="M40 2l6 4-6 4z" fill="currentColor" />
        </svg>
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <GroupMark tone={to?.tone ?? 0} />
          {to?.name ?? flow.to}
        </span>
        <span className="text-muted-foreground min-w-0">
          {flow.recordId && (
            <b className="text-foreground font-mono text-xs font-medium">
              {recordNumber(flow.recordId)}
            </b>
          )}{" "}
          {record ? `${record.title} · ` : ""}
          {flow.text}
        </span>
        <time className="text-muted-foreground ml-auto text-xs tabular-nums">
          {new Date(flow.created).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
    </div>
  );
}

/** Plain names for the record details a linked record card can show. */
const RECORD_CARD_LABELS: Record<string, string> = {
  status: "Status",
  assignee: "Assigned to",
  customer: "Customer",
  dueDate: "Due date",
};

export function MessageTimeline({
  visibleMessages,
  allMessages,
  flows = [],
  onOpenRecord,
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
  /** Handoffs for this conversation, placed between messages by time. */
  flows?: CommsFlow[];
  onOpenRecord?: (recordId: string) => void;
  records: SampleRecord[];
  threads: Thread[];
  highlightedId?: string;
  mutable: boolean;
} & TimelinePeople &
  TimelineActions) {
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
        const authorId = messageAuthorId(message, people);
        const person = people.find((item) => item.id === authorId);
        const authorName = person?.name ?? message.author;
        const own = authorId === viewerId;
        const previous = visibleMessages[index - 1];
        // Handoffs that happened before this message and after the last one.
        const flowsBefore = flows.filter(
          (flow) =>
            flow.created <= message.created &&
            (!previous || flow.created > previous.created),
        );
        const grouped =
          !flowsBefore.length &&
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
            {flowsBefore.map((flow) => (
              <FlowRow key={flow.id} flow={flow} records={records} />
            ))}
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
                          {formatFileSize(file.size)} · Not uploaded
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
                  {message.recordId &&
                    preferences.previews &&
                    (() => {
                      const record = records.find(
                        (item) => item.id === message.recordId,
                      );
                      const title = record?.title ?? "Linked record";
                      const { module, group } = recordContext(record, people);
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
                              {settings.recordCardFields.includes("title") && (
                                <span className="truncate text-sm font-semibold">
                                  {title}
                                </span>
                              )}
                            </button>
                            <Link
                              href={`/openview?record=${encodeURIComponent(message.recordId)}`}
                              aria-label={`OpenView: open ${title}`}
                              className="text-action-text shrink-0 text-xs font-semibold hover:underline"
                            >
                              OpenView
                            </Link>
                          </div>
                          {settings.recordCardFields.some(
                            (field) => field !== "title",
                          ) && (
                            <dl className="grid grid-cols-2 sm:grid-cols-3">
                              {settings.recordCardFields
                                .filter((field) => field !== "title")
                                .map((field) => (
                                  <div
                                    key={field}
                                    className="min-w-0 border-r px-3 py-2 last:border-r-0"
                                  >
                                    <dt className="text-muted-foreground text-xs">
                                      {RECORD_CARD_LABELS[field] ?? field}
                                    </dt>
                                    <dd className="truncate font-mono text-xs">
                                      {String(
                                        record?.[field as keyof SampleRecord] ??
                                          "—",
                                      )}
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
      {flows
        .filter(
          (flow) =>
            flow.created > (visibleMessages.at(-1)?.created ?? -Infinity),
        )
        .map((flow) => (
          <FlowRow key={flow.id} flow={flow} records={records} />
        ))}
    </>
  );
}
