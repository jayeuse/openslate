import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
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
import { Avatar, MessageMenu } from "./floating";
import { PersonLink } from "./person-link";
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
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { VirtualMessageList } from "./virtual-message-list";

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

type TimelineProps = {
  visibleMessages: Message[];
  allMessages: Message[];
  onOpenRecord?: (recordId: string) => void;
  records: SampleRecord[];
  threads: Thread[];
  highlightedId?: string;
  mutable: boolean;
  readBoundary?: number;
  firstUnread?: number | null;
  editRequest?: { id: string; text: string };
  hasOlder?: boolean;
  viewportRef?: RefObject<HTMLDivElement | null>;
  restoreAnchor?: (align: (id: string, top: number) => boolean) => void;
  targetId?: string;
  followLatest?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
} & TimelinePeople &
  TimelineActions;

export function MessageTimeline(props: TimelineProps) {
  const region = useWorkspaceDisplayRegion();
  const timezone = region?.timezone ?? "UTC",
    locale = region?.locale ?? "en-US";
  const timeFormat = region?.timeFormat,
    dateFormat = region?.dateFormat;
  const formats = useMemo(() => {
    const clock: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      ...(timeFormat === "24h"
        ? { hour12: false, hourCycle: "h23" }
        : timeFormat === "12h"
          ? { hour12: true }
          : {}),
    } as const;
    const dateLocale =
      dateFormat && dateFormat !== "organization"
        ? { dmy: "en-GB", mdy: "en-US", ymd: "sv-SE" }[dateFormat]
        : locale;
    return {
      key: new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      day: new Intl.DateTimeFormat(locale, {
        timeZone: timezone,
        month: "long",
        day: "numeric",
      }),
      time: new Intl.DateTimeFormat(locale, clock),
      stamp: new Intl.DateTimeFormat(dateLocale, {
        ...clock,
        ...(props.preferences?.timestamps === "full"
          ? ({ year: "numeric", month: "short", day: "numeric" } as const)
          : {}),
      }),
    };
  }, [timezone, locale, timeFormat, dateFormat, props.preferences?.timestamps]);
  const {
    visibleMessages,
    allMessages,
    people,
    roles,
    records,
    threads,
    highlightedId,
    ...rest
  } = props;
  const [editing, setEditing] = useState("");
  const [editText, setEditText] = useState("");
  useEffect(() => {
    if (props.editRequest) {
      setEditing(props.editRequest.id);
      setEditText(props.editRequest.text);
    }
  }, [props.editRequest]);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const actions = useMemo(
    () => ({
      onChange: (...args: Parameters<TimelineActions["onChange"]>) =>
        latest.current.onChange(...args),
      onDelete: (...args: Parameters<TimelineActions["onDelete"]>) =>
        latest.current.onDelete(...args),
      onReply: (message: Message) => latest.current.onReply(message),
      onThread: (message: Message) => latest.current.onThread(message),
      onJump: (id: string) => latest.current.onJump(id),
      onDirect: (id: string) => latest.current.onDirect(id),
      onOpenRecord: (id: string) => latest.current.onOpenRecord?.(id),
      onMessageTool: (
        ...args: Parameters<NonNullable<TimelineActions["onMessageTool"]>>
      ) => latest.current.onMessageTool?.(...args),
    }),
    [],
  );
  const maps = useMemo(
    () => ({
      people: new Map(people.map((person) => [person.id, person])),
      roles: new Map(roles.map((role) => [role.id, role.name])),
      messages: new Map(allMessages.map((message) => [message.id, message])),
      threads: new Map(threads.map((thread) => [thread.messageId, thread])),
      records: new Map(records.map((record) => [record.id, record])),
    }),
    [people, roles, allMessages, threads, records],
  );
  const unreadIndex =
    props.firstUnread != null
      ? visibleMessages.findIndex(
          (message) => message.seq === props.firstUnread,
        )
      : -1;
  const renderRow = (index: number, tabIndex = -1) => {
    const message = visibleMessages[index];
    const person = maps.people.get(messageAuthorId(message));
    const quote = maps.messages.get(message.replyToId ?? "");
    const previous = visibleMessages[index - 1];
    const day =
      !previous ||
      formats.key.format(previous.created) !==
        formats.key.format(message.created)
        ? formats.day.format(message.created)
        : undefined;
    return (
      <TimelineRow
        key={message.id}
        {...rest}
        {...actions}
        message={message}
        tabIndex={tabIndex}
        position={props.viewportRef ? index + 1 : undefined}
        pageSize={props.viewportRef ? visibleMessages.length : undefined}
        previous={previous}
        dayLabel={day}
        timeLabel={formats.time.format(message.created)}
        timestamp={formats.stamp.format(message.created)}
        unread={index === unreadIndex}
        person={person}
        peopleById={maps.people}
        roleName={maps.roles.get(person?.role ?? "") ?? "Unassigned"}
        quote={quote}
        quoteAuthor={
          quote
            ? (maps.people.get(messageAuthorId(quote))?.name ?? quote.author)
            : ""
        }
        thread={maps.threads.get(message.id)}
        record={maps.records.get(message.recordId ?? "")}
        highlightedId={highlightedId === message.id ? highlightedId : undefined}
        editing={editing === message.id}
        editText={editing === message.id ? editText : ""}
        setEditing={setEditing}
        setEditText={setEditText}
      />
    );
  };
  return props.viewportRef ? (
    <VirtualMessageList
      messages={visibleMessages}
      viewportRef={props.viewportRef}
      restoreAnchor={props.restoreAnchor}
      targetId={props.targetId}
      followLatest={props.followLatest}
      retainedId={editing}
      header={props.header}
      footer={props.footer}
    >
      {renderRow}
    </VirtualMessageList>
  ) : (
    visibleMessages.map((_, index) => renderRow(index))
  );
}

const TimelineRow = memo(function TimelineRow({
  dayLabel,
  timeLabel,
  timestamp,
  unread,
  message,
  position,
  pageSize,
  tabIndex,
  previous,
  person,
  peopleById,
  roleName,
  quote,
  quoteAuthor,
  thread,
  record,
  editing,
  editText,
  setEditing,
  setEditText,
  onOpenRecord,
  highlightedId,
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
}: Omit<
  TimelineProps,
  "visibleMessages" | "allMessages" | "records" | "threads" | "people" | "roles"
> & {
  message: Message;
  position?: number;
  pageSize?: number;
  tabIndex?: number;
  dayLabel?: string;
  timeLabel: string;
  timestamp: string;
  unread: boolean;
  previous?: Message;
  person?: TimelinePeople["people"][number];
  peopleById: ReadonlyMap<string, TimelinePeople["people"][number]>;
  roleName: string;
  quote?: Message;
  quoteAuthor: string;
  thread?: Thread;
  record?: SampleRecord;
  editing: boolean;
  editText: string;
  setEditing: (id: string) => void;
  setEditText: (text: string) => void;
}) {
  const { client } = useCommsClient();
  const domId =
    position !== undefined && message.parentId
      ? `channel-${message.id}`
      : message.id;
  const lifetime = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  // Failures show as a visible OpenComms notice (state/comms-feedback.ts).
  const setNotice = reportCommsError;
  const [now, setNow] = useState(() => Date.now());
  function finishEditing() {
    setEditing("");
    requestAnimationFrame(() => {
      if (!lifetime.current?.signal.aborted)
        document
          .getElementById(domId)
          ?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
          ?.focus({ preventScroll: true });
    });
  }
  const authorId = messageAuthorId(message);
  const authorName = person?.name ?? message.author;
  const own = authorId === viewerId;
  const grouped =
    preferences.groupMessages &&
    !dayLabel &&
    previous &&
    messageAuthorId(previous) === authorId &&
    Math.abs(message.created - previous.created) < 5 * 60 * 1000;
  const Item = position === undefined ? MessageScrollerItem : "div";
  return (
    <Item
      key={message.id}
      {...(position === undefined
        ? { messageId: message.id }
        : { "data-message-id": message.id })}
      data-comms-seq={message.seq}
    >
      {dayLabel && (
        <div className="text-muted-foreground my-5 flex items-center gap-3 px-3 text-xs font-medium">
          <Separator className="flex-1" />
          {dayLabel}
          <Separator className="flex-1" />
        </div>
      )}
      {unread && (
        <div
          role="separator"
          aria-label="New messages"
          className="text-action-text my-3 flex items-center gap-3 text-xs font-semibold"
        >
          <Separator className="flex-1" />
          <span>New messages</span>
          <Separator className="flex-1" />
        </div>
      )}
      <MessageMenu
        tabIndex={tabIndex}
        sequence={message.seq}
        position={position}
        pageSize={pageSize}
        onOpen={() => setNow(Date.now())}
        id={domId}
        highlighted={highlightedId === message.id}
        className={cn(
          "hover:bg-muted/40 px-3 max-sm:pr-14",
          preferences.density === "compact" ? "py-0.5" : "py-1.5",
          !grouped && "mt-3",
        )}
        label={`${authorName}, ${timeLabel}`}
        own={own}
        mutable={mutable && !message.deleted}
        canReact={capabilities?.react.allowed ?? false}
        canReply={capabilities?.reply.allowed ?? false}
        canCreateThread={
          !message.parentId && (capabilities?.createThread.allowed ?? false)
        }
        canReport={membershipRole !== undefined && membershipRole !== "guest"}
        canEdit={own && mutable && !message.deleted}
        editExpired={
          settings.editWindowMinutes > 0 &&
          now - message.created > settings.editWindowMinutes * 60 * 1000
        }
        allowedReactions={settings.allowedReactions}
        onTool={(view, opener) => onMessageTool?.(view, message.id, opener)}
        canElevate={elevated && mutable && !message.deleted}
        canDelete={
          mutable &&
          !message.deleted &&
          (own
            ? settings.deleteWindowMinutes === 0 ||
              now - message.created <= settings.deleteWindowMinutes * 60 * 1000
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
                  <PersonLink
                    avatarOnly
                    person={person}
                    roleName={roleName}
                    presence={presenceLabel(presence, person.id)}
                    onMessage={onDirect}
                  />
                ) : (
                  <Avatar name={authorName} />
                ))}
              <strong className="min-w-0 truncate text-sm">
                <bdi>{authorName}</bdi>
              </strong>
              {preferences.timestamps !== "none" && (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {timestamp}
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
                    ? `${quoteAuthor}: ${quote.text}`
                    : "Original message unavailable"}
                </span>
              </Button>
            )}
            {editing && own && mutable ? (
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
                    finishEditing();
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
                    setNotice("The message could not be saved. Try again.");
                    return;
                  }
                  finishEditing();
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
                  <Action type="button" size="sm" onClick={finishEditing}>
                    Cancel edit
                  </Action>
                </div>
              </form>
            ) : (
              <p
                dir="auto"
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
            {message.edited && (
              <span className="text-muted-foreground text-xs">edited</span>
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
                          const download = await client.downloadAttachment(
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
                const title = record?.title ?? "Linked record";
                const { module, group } = recordContext(record);
                return (
                  <div
                    className={cn(
                      "border-card-edge bg-card mt-2 max-w-md overflow-hidden rounded-[calc(var(--radius)*1.25)] border",
                      TONE_EDGE[group?.tone ?? 0],
                    )}
                  >
                    <div className="flex flex-col gap-1 border-b sm:flex-row sm:items-center sm:gap-2 sm:pr-3">
                      <button
                        type="button"
                        onClick={() => onOpenRecord?.(message.recordId!)}
                        className="hover:bg-muted focus-visible:outline-ring flex min-h-11 min-w-0 flex-1 flex-col items-start gap-1 px-3 py-2 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 sm:flex-row sm:items-center sm:gap-2"
                      >
                        <span className="sr-only">Open record: </span>
                        <span className="text-muted-foreground flex items-center gap-2 text-xs sm:shrink-0">
                          <TableGlyph />
                          <span>
                            {group ? `${group.name} › ` : ""}
                            {module}
                          </span>
                        </span>
                        {record && (
                          <span className="min-w-0 text-sm font-semibold break-words whitespace-normal">
                            {title}
                          </span>
                        )}
                      </button>
                      <Link
                        href={`/openview?record=${encodeURIComponent(message.recordId)}`}
                        aria-label={`Open in OpenView: ${title}`}
                        className="text-action-text inline-flex min-h-11 shrink-0 items-center px-3 text-xs font-semibold hover:underline sm:min-h-6 sm:px-0"
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
                    aria-label={`${emoji} ${users.length}: ${users.map((id) => peopleById.get(id)?.name ?? "Unavailable person").join(", ")}`}
                    title={users
                      .map(
                        (id) =>
                          peopleById.get(id)?.name ?? "Unavailable person",
                      )
                      .join(", ")}
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
    </Item>
  );
});
