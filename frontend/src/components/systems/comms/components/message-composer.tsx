import type { Person } from "../../shared/data/sample-people";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import { Clock, Paperclip, Reply, Send, X } from "lucide-react";
import type { SampleRecord } from "../../shared/data/sample-data";
import {
  messageAuthorId,
  threadMessages,
  type LocalAttachment,
  type Message,
} from "../domain/view-model";
import { Alert } from "@/components/ui/alert";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Choice } from "../../shared/components/ui";
import {
  useSampleRuntime,
  useSampleState,
} from "../../shared/runtime/sample-state";
import {
  useVerifiedWorkspaceUserId,
  useVerifiedWorkspaceOrganizationId,
} from "../../shared/runtime/workspace-identity";
import {
  legacyCommsDraftTextKey,
  ownedCommsDraftTextId,
  useCommsDraftText,
} from "../state/draft-text";
import {
  localAttachmentUrl,
  releaseLocalAttachment,
} from "../../shared/runtime/local-attachments";
import { EmojiPicker } from "./floating";
import {
  DEFAULT_COMMS_PREFERENCES,
  DEFAULT_COMMS_SETTINGS,
  type CommsPreferences,
  type CommsSettings,
} from "../domain/configuration";
import { formatFileSize, type MessageDraft } from "./message-shared";
import { useCommsClient } from "../state/client-context";
import {
  composerFailure,
  hasMention,
  shouldSendMessage,
} from "../domain/composer-input";
import { useComposerUploads } from "../state/use-composer-uploads";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";

type FilePreview = LocalAttachment & { previewUrl?: string };
export function MessageComposer({
  id,
  conversationId = id,
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
  rootId,
  onEditLast,
  pending = false,
  preferences = DEFAULT_COMMS_PREFERENCES,
  settings = DEFAULT_COMMS_SETTINGS,
}: {
  id: string;
  conversationId?: string;
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
  rootId?: string;
  onEditLast?: (message: { id: string; text: string }) => void;
  pending?: boolean;
  preferences?: CommsPreferences;
  settings?: CommsSettings;
}) {
  const { client } = useCommsClient();
  const workspace = useCommsWorkspaceView();
  const sendIdentity = useRef<{ draft: string; key: string } | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const runtime = useSampleRuntime();
  const userId = useVerifiedWorkspaceUserId();
  const organizationId = useVerifiedWorkspaceOrganizationId();
  const ownedComposerId = ownedCommsDraftTextId(userId, id, organizationId);
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
    ownedComposerId,
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
  const [scheduleOpen, setScheduleOpen] = useSampleState(
    `comms-draft-schedule-open-${id}`,
    false,
  );
  const [scheduleAt, setScheduleAt] = useSampleState(
    `comms-draft-schedule-at-${id}`,
    "",
  );
  const [mentions, setMentions] = useSampleState<
    { id: string; name: string }[]
  >(`comms-draft-mentions-${id}`, []);
  const [caret, setCaret] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [choice, setChoice] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [backoff, setBackoff] = useState(0);
  const fileInputId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const restoreComposerFocus = useRef(false);
  const isPending = sending || pending;
  const uploads = useComposerUploads(conversationId, settings, (file) =>
    setFiles((current) => [...current, file]),
  );
  const members =
    workspace.client === client
      ? (workspace.members[conversationId] ?? [])
      : [];
  const capabilities =
    workspace.client === client
      ? workspace.checks[conversationId]?.capabilities
      : undefined;
  const canAttach = canPost && (capabilities?.attachFiles.allowed ?? false);
  const candidates = [
    ...people
      .filter(
        (person) =>
          person.active &&
          members.some((member) => member.user_id === person.id),
      )
      .map(({ id, name }) => ({ id, name })),
    ...(capabilities?.mentionChannel.allowed
      ? [
          { id: "channel", name: "channel" },
          { id: "here", name: "here" },
        ]
      : []),
  ];
  const selectedMentions = mentions.filter((mention) =>
    hasMention(text, mention.name),
  );
  const mentionError = selectedMentions.some(
    (mention) => !candidates.some((person) => person.id === mention.id),
  )
    ? "A mentioned person or group is no longer available."
    : settings.mentionLimit > 0 &&
        selectedMentions.length > settings.mentionLimit
      ? `This conversation allows ${settings.mentionLimit} mention${settings.mentionLimit === 1 ? "" : "s"} per message.`
      : "";
  const token = mentionOpen
    ? /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
    : null;
  const options = token
    ? candidates
        .filter((person) =>
          person.name
            .toLocaleLowerCase()
            .includes(token[1].toLocaleLowerCase()),
        )
        .slice(0, 8)
    : [];
  const lastSent = useMemo(
    () =>
      Math.max(
        0,
        ...[...workspace.messages, ...workspace.threads.flatMap(threadMessages)]
          .filter(
            (message) =>
              message.conversation === conversationId &&
              messageAuthorId(message) === userId,
          )
          .map((message) => message.created),
      ),
    [workspace.messages, workspace.threads, conversationId, userId],
  );
  const until = Math.max(backoff, lastSent + settings.slowModeSeconds * 1000);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => {
    setNow(Date.now());
    if (until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  useEffect(() => {
    const input = textarea.current;
    if (input) {
      input.style.height = "auto";
      input.style.height = `${Math.min(160, input.scrollHeight)}px`;
    }
  }, [text]);
  function insert(
    value: string,
    from = textarea.current?.selectionStart ?? text.length,
    to = textarea.current?.selectionEnd ?? from,
  ) {
    const next = text.slice(0, from) + value + text.slice(to);
    setText(next);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      if (textarea.current?.value !== next) return;
      textarea.current?.focus();
      textarea.current?.setSelectionRange(
        from + value.length,
        from + value.length,
      );
    });
  }
  function chooseMention(person: (typeof candidates)[number]) {
    if (!token) return;
    insert(`@${person.name} `, caret - token[1].length - 1, caret);
    setMentions((current) => [
      ...current.filter((item) => item.id !== person.id),
      person,
    ]);
  }
  async function editLast() {
    const signal = lifetime.current?.signal;
    if (!client || !signal || !onEditLast) return;
    try {
      let before: number | undefined;
      for (;;) {
        const request = {
          limit: 100,
          ...(before === undefined ? {} : { before_seq: before }),
        };
        const page = rootId
          ? await client.getReplies(conversationId, rootId, request, { signal })
          : await client.getHistory(conversationId, request, { signal });
        const message = [...page.items]
          .reverse()
          .find((row) => row.author_id === userId && row.state === "live");
        if (message?.state === "live") {
          if (
            settings.editWindowMinutes > 0 &&
            Date.now() - Date.parse(message.created_at) >
              settings.editWindowMinutes * 60000
          ) {
            setError("The configured edit window has ended.");
            return;
          }
          await client.bootstrap({ signal });
          if (!signal.aborted)
            onEditLast({ id: message.id, text: message.body });
          return;
        }
        const next = page.items[0]?.seq;
        if (!page.pagination.has_older || next === undefined || next === before)
          break;
        before = next;
      }
      setError("No earlier message of yours is available to edit.");
    } catch {
      if (!signal.aborted)
        setError("The message could not be opened for editing.");
    }
  }
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
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          if (canAttach && !isPending)
            uploads.add(Array.from(event.dataTransfer.files), files.length);
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          isPending ||
          uploads.items.length > 0 ||
          mentionError ||
          seconds > 0 ||
          !canPost ||
          (!text.trim() && !files.length && !recordId)
        )
          return;
        const submittedTextRevision = draftText.revision;
        restoreComposerFocus.current = true;
        setSending(true);
        try {
          const signal = lifetime.current?.signal;
          if (!signal || signal.aborted) return;
          const scheduled = scheduleOpen ? Date.parse(scheduleAt) : undefined;
          if (
            scheduled !== undefined &&
            (!Number.isFinite(scheduled) || scheduled <= Date.now())
          ) {
            setError("Choose a future date and time.");
            return;
          }
          const mentionUserIds = selectedMentions
            .filter((person) => person.id !== "channel" && person.id !== "here")
            .map((person) => person.id);
          const mentionsChannel = selectedMentions.some(
              (person) => person.id === "channel",
            ),
            mentionsHere = selectedMentions.some(
              (person) => person.id === "here",
            );
          const sendAt =
            scheduled === undefined
              ? undefined
              : new Date(scheduled).toISOString();
          const fingerprint = JSON.stringify({
            text,
            files: files.map((file) => file.id),
            recordId,
            replyToId: replyingTo?.id,
            mentionUserIds,
            mentionsChannel,
            mentionsHere,
            sendAt,
          });
          if (sendIdentity.current?.draft !== fingerprint)
            sendIdentity.current = {
              draft: fingerprint,
              key: crypto.randomUUID(),
            };
          const error = await onSend({
            clientKey: sendIdentity.current.key,
            signal,
            sentAt: Math.round(performance.timeOrigin + event.timeStamp),
            text,
            files: files.map(({ id, name, size, type }) => ({
              id,
              name,
              size,
              type,
            })),
            recordId,
            mentionUserIds,
            mentionsChannel,
            mentionsHere,
            scheduleAt: sendAt,
            onFailure: (error) => {
              const failure = composerFailure(error);
              if (
                !signal.aborted &&
                failure?.status === 429 &&
                !Array.isArray(failure.body.detail) &&
                failure.body.detail.code === "comms_slow_mode"
              )
                setBackoff(Date.now() + failure.retry_after_seconds * 1000);
            },
          });
          if (error) {
            setError(error);
            return;
          }
          if (signal.aborted) return;
          setError("");
          const cleared = await draftText.clear(submittedTextRevision);
          if (!cleared) return;
          sendIdentity.current = null;
          setFiles([]);
          setRecordId("");
          setRecordPickerOpen(false);
          setMentions([]);
          setScheduleOpen(false);
          setScheduleAt("");
        } catch {
          setError(
            "The message could not be sent. Your draft is still available.",
          );
        } finally {
          setSending(false);
        }
      }}
    >
      {(error || uploads.error || mentionError) && (
        <Alert role="alert" variant="destructive" className="mb-2 p-2 text-xs">
          {mentionError || uploads.error || error}
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
              <bdi>
                {people.find(
                  (person) => person.id === messageAuthorId(replyingTo),
                )?.name ?? replyingTo.author}
              </bdi>
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
      {scheduleOpen && (
        <div className="mb-2">
          <label htmlFor={`schedule-${fileInputId}`} className="text-xs">
            Send at (local time)
          </label>
          <Input
            id={`schedule-${fileInputId}`}
            type="datetime-local"
            className="min-h-11"
            value={scheduleAt}
            onChange={(event) => setScheduleAt(event.target.value)}
            disabled={!canPost || isPending}
          />
          <p className="text-muted-foreground text-xs">
            This local example sends scheduled messages from Scheduled messages
            → Send Now.
          </p>
        </div>
      )}
      {uploads.items.map((item) => (
        <div
          key={item.id}
          className="mb-2 flex flex-wrap items-center gap-2 text-xs"
        >
          <bdi>{item.file.name}</bdi>
          {item.active ? (
            <progress
              aria-label={`Upload ${item.file.name}`}
              max={100}
              value={item.progress}
              className="min-w-0 flex-1"
            />
          ) : (
            <>
              <span role="alert">{item.error}</span>
              <Button
                type="button"
                variant="outline"
                disabled={!canAttach || isPending}
                onClick={() => void uploads.retry(item)}
              >
                Try again
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            aria-label={`Cancel upload ${item.file.name}`}
            onClick={() => uploads.remove(item.id)}
          >
            <X />
          </Button>
        </div>
      ))}
      {token && canPost && !isPending && (
        <div
          role="listbox"
          aria-label="Mention members"
          id={`mentions-${fileInputId}`}
          className="mb-2 max-h-40 overflow-y-auto rounded-md border p-1"
        >
          {options.length ? (
            options.map((person, index) => (
              <Button
                key={person.id}
                id={`mention-${fileInputId}-${index}`}
                type="button"
                role="option"
                aria-label={person.name}
                aria-selected={index === choice}
                variant={index === choice ? "secondary" : "ghost"}
                className="min-h-11 w-full justify-start"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseMention(person)}
              >
                <bdi>{person.name}</bdi>
              </Button>
            ))
          ) : (
            <p className="p-2 text-xs">No matching members.</p>
          )}
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
                  <bdi>{file.name}</bdi>
                </AttachmentTitle>
                <AttachmentDescription>
                  {formatFileSize(file.size)} · Local sample attachment
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
          dir="auto"
          className="max-h-40 min-h-12 resize-none"
          aria-describedby={seconds ? `cooldown-${fileInputId}` : undefined}
          aria-controls={token ? `mentions-${fileInputId}` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            token && options.length
              ? `mention-${fileInputId}-${choice}`
              : undefined
          }
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setChoice(0);
            setMentionOpen(true);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onBlur={(event) => {
            if (
              !(event.relatedTarget instanceof Element) ||
              !event.relatedTarget.closest('[role="listbox"]')
            )
              setMentionOpen(false);
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              if (canAttach && !isPending)
                uploads.add(
                  Array.from(event.clipboardData.files),
                  files.length,
                );
            }
          }}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "Escape") {
              if (token || recordPickerOpen || scheduleOpen || replyingTo) {
                event.preventDefault();
                event.stopPropagation();
                if (token) setMentionOpen(false);
                else if (recordPickerOpen) setRecordPickerOpen(false);
                else if (scheduleOpen) setScheduleOpen(false);
                else onCancelReply();
              }
              return;
            }
            if (token && options.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setChoice(
                  (value) =>
                    (value +
                      (event.key === "ArrowDown" ? 1 : options.length - 1)) %
                    options.length,
                );
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault();
                chooseMention(options[choice] ?? options[0]);
                return;
              }
            }
            if (
              event.key === "ArrowUp" &&
              !text &&
              !files.length &&
              !recordId &&
              onEditLast
            ) {
              event.preventDefault();
              event.stopPropagation();
              void editLast();
              return;
            }
            if (
              shouldSendMessage(event.nativeEvent, preferences.sendShortcut)
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          disabled={!canPost || isPending}
          placeholder={`Message ${conversationName}…`}
        />
        <InputGroupAddon
          align="block-end"
          className="flex-wrap gap-1 [&_button]:min-h-11 [&_button]:min-w-11 sm:[&_button]:min-h-8 sm:[&_button]:min-w-8"
        >
          <Input
            id={fileInputId}
            type="file"
            multiple
            accept={uploads.accept}
            aria-label="Upload files"
            className="sr-only"
            disabled={!canAttach || isPending}
            onChange={(event) => {
              const chosen = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (canAttach && !isPending) uploads.add(chosen, files.length);
            }}
          />
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Choose files"
            disabled={!canAttach || isPending}
            onClick={() => document.getElementById(fileInputId)?.click()}
          >
            <Paperclip className="size-4" />
          </InputGroupButton>
          <EmojiPicker
            disabled={!canPost || isPending}
            onSelect={(emoji) => insert(emoji)}
          />
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Attach record"
            disabled={
              !canPost || isPending || !capabilities?.linkRecords.allowed
            }
            aria-expanded={recordPickerOpen}
            onClick={() => setRecordPickerOpen(!recordPickerOpen)}
          >
            <span className="text-base" aria-hidden="true">
              ↗
            </span>
          </InputGroupButton>
          {canPost && (
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Schedule send"
              aria-expanded={scheduleOpen}
              disabled={isPending}
              onClick={() => setScheduleOpen(!scheduleOpen)}
            >
              <Clock className="size-4" />
            </InputGroupButton>
          )}
          <span className="text-muted-foreground ml-auto text-xs">
            {preferences.sendShortcut === "ctrl-enter"
              ? "Ctrl + Enter to send"
              : "Enter to send"}
          </span>
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="default"
            aria-label={scheduleOpen ? "Schedule message" : sendLabel}
            disabled={
              !canPost ||
              isPending ||
              uploads.items.length > 0 ||
              !!mentionError ||
              seconds > 0 ||
              (!text.trim() && !files.length && !recordId)
            }
          >
            <Send className="size-4" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {seconds > 0 && (
        <p
          id={`cooldown-${fileInputId}`}
          role="status"
          className="text-muted-foreground mt-1 text-xs"
        >
          Send available in {seconds}s
        </p>
      )}
    </form>
  );
}
