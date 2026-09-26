import type { Person } from "../../access/domain/model";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { Paperclip, Reply, Send, X } from "lucide-react";
import type { SampleRecord } from "../../shared/data/sample-data";
import {
  messageAuthorId,
  type LocalAttachment,
  type Message,
} from "../domain/model";
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
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import {
  legacyCommsDraftTextKey,
  ownedCommsDraftTextId,
  useCommsDraftText,
} from "../state/draft-text";
import {
  cacheLocalAttachment,
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

type FilePreview = LocalAttachment & { previewUrl?: string };
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
  const userId = useVerifiedWorkspaceUserId();
  const ownedComposerId = ownedCommsDraftTextId(userId, id);
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
                  {formatFileSize(file.size)} · Not uploaded
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
          <span className="text-muted-foreground ml-auto text-xs">
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
