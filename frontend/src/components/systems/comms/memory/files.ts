import type { CommsClient } from "../contract/client";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { directBlocked, policyFailure } from "../domain/access";
import { capabilityCheck } from "../domain/capabilities";
import { postDenied } from "../domain/posting";
import { invalidInput } from "../domain/settings";
import {
  assertRequestActive,
  capabilityDenied,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import {
  conversationSettings,
  readableConversation,
} from "./message-projections";
import type { MemoryCommsState } from "./model";
import { invalidMemoryState } from "./snapshot";
import type {
  MemoryCommand,
  MemoryExecution,
  MemoryStore,
} from "./store-types";

export type MemoryFileFamily = Pick<
  CommsClient,
  "reserveAttachment" | "uploadAttachment" | "downloadAttachment"
>;

export interface MemoryFileResources {
  readonly store: MemoryStore;
  assertCurrent(store: MemoryStore): void;
  preparePurge(store: MemoryStore): PreparedFilePurge;
  bind(binding: MemoryClientBinding): MemoryFileFamily;
  assertSendReady(input: {
    store: MemoryStore;
    current: Readonly<MemoryCommsState>;
    execution: MemoryExecution;
    conversation_id: string;
    attachment_ids: readonly string[];
  }): void;
  dispose(): void;
}

/** Internal deletion plan; no bytes, mutable cells or protected proofs escape. */
export interface PreparedFilePurge {
  readonly signal: AbortSignal;
  readonly committed: boolean;
  stage(releasedFileIds: readonly string[]): void;
  readonly finalize: () => undefined;
}

const fileKey = (id: string) => `file:${id}`;
const mediaTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function cancelled(): never {
  throw Object.assign(new Error("OpenComms operation cancelled"), {
    kind: "cancelled" as const,
  });
}
function fileNotFound(): never {
  return policyFailure({
    status: 404,
    body: { detail: { code: "file_not_found", message: "File not found" } },
  });
}
function fileRow(
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  conversationId: string,
  fileId: string,
) {
  readableConversation(state, context, conversationId);
  const row = state.files[fileId];
  if (
    !row ||
    row.org_id !== context.org_id ||
    row.conversation_id !== conversationId ||
    row.is_deleted
  )
    return fileNotFound();
  return row;
}

function admitFileWrite(
  binding: MemoryClientBinding,
  state: Readonly<MemoryCommsState>,
  context: C.CommsContext,
  id: string,
  filename: string,
  size: number,
  now: number,
) {
  const conversation = readableConversation(state, context, id);
  const check = capabilityCheck(state, context, id);
  const settings = conversationSettings(state, id);
  if (
    check.membership_role === "guest" ||
    conversation.archived_at ||
    settings.locked ||
    (settings.restricted_person_ids.includes(context.user_id) &&
      (!settings.restriction_until ||
        Date.parse(settings.restriction_until) > now)) ||
    (conversation.kind === "direct" &&
      Object.keys(state.members[id] ?? {}).some((userId) =>
        directBlocked(state, context.user_id, userId),
      ))
  )
    return postDenied();
  requireAvailable(
    binding,
    context,
    {
      scope:
        conversation.kind === "channel"
          ? { kind: "channel", id }
          : { kind: "workspace" },
      capability: "attachFiles",
    },
    check.capabilities.attachFiles,
  );
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  if (
    !mediaTypes[extension] ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > Math.min(10, settings.max_file_size_mb || 10) * 1024 * 1024 ||
    (settings.allowed_file_types.length &&
      !settings.allowed_file_types.some((type) => type === extension))
  )
    return invalidInput();
  return mediaTypes[extension];
}

type CommittedFile = { bytes: Blob; proof: C.CommsFile };
function matches(entry: CommittedFile | undefined, row: C.CommsFile) {
  const proof = entry?.proof;
  return Boolean(
    proof &&
    row.state === "ready" &&
    !row.is_deleted &&
    proof.id === row.id &&
    proof.org_id === row.org_id &&
    proof.conversation_id === row.conversation_id &&
    proof.creator_id === row.creator_id &&
    proof.filename === row.filename &&
    proof.expected_size === row.expected_size &&
    proof.actual_size === row.actual_size &&
    proof.media_type === row.media_type &&
    entry?.bytes.size === row.actual_size,
  );
}

/** Local sample bytes only; no server parser, remote storage or object URLs. */
export function createMemoryFileResources(
  store: MemoryStore,
): MemoryFileResources {
  const anchor = store.bind(store.exportSnapshot().owner);
  let retired = false;
  let committed = new Map<string, CommittedFile>();
  const retire = () => {
    retired = true;
    committed = new Map();
  };
  anchor.lifetimeSignal.addEventListener("abort", retire, { once: true });
  const assertCurrent = (candidate: MemoryStore) => {
    if (candidate !== store) return invalidMemoryState();
    if (retired || !anchor.isCurrentFor(store)) return cancelled();
  };
  const resources: MemoryFileResources = {
    store,
    assertCurrent,
    preparePurge(candidate) {
      assertCurrent(candidate);
      const pendingReceipt = Object.freeze({ accepted: false });
      const acceptedReceipt = Object.freeze({ accepted: true });
      let receiptRoot: Readonly<{ accepted: boolean }> = pendingReceipt;
      let nextFiles = committed;
      let staged = false;
      return {
        signal: anchor.lifetimeSignal,
        get committed() {
          return receiptRoot === acceptedReceipt;
        },
        stage(ids) {
          assertCurrent(candidate);
          if (staged || receiptRoot === acceptedReceipt)
            return invalidMemoryState();
          nextFiles = new Map(committed);
          for (const id of ids) nextFiles.delete(id);
          staged = true;
        },
        // Installed directly on the purge command, never called by another hook.
        finalize: () => {
          committed = nextFiles;
          receiptRoot = acceptedReceipt;
          return undefined;
        },
      };
    },
    assertSendReady({
      store: candidate,
      current,
      execution,
      conversation_id,
      attachment_ids,
    }) {
      assertCurrent(candidate);
      if (current.org_id !== execution.context.org_id)
        return invalidMemoryState();
      for (const id of attachment_ids) {
        const row = current.files[id];
        if (
          !row ||
          row.org_id !== execution.context.org_id ||
          row.conversation_id !== conversation_id ||
          row.creator_id !== execution.context.user_id ||
          !matches(committed.get(id), row)
        )
          return invalidInput();
      }
    },
    bind(binding) {
      assertCurrent(store);
      const { handle } = binding;
      if (handle.lifetimeSignal.aborted) return cancelled();
      if (!handle.isCurrentFor(store)) return invalidMemoryState();
      const active = (options?: C.RequestOptions) => {
        assertCurrent(store);
        assertRequestActive(options);
        if (handle.lifetimeSignal.aborted) return cancelled();
        if (!handle.isCurrentFor(store)) return invalidMemoryState();
      };
      return {
        async reserveAttachment(conversationId, request, options) {
          active(options);
          const parsed = S.attachmentReservationSchema.safeParse(request);
          if (!parsed.success) return invalidInput();
          const result = await handle.command({
            signal: AbortSignal.any([
              anchor.lifetimeSignal,
              ...(options?.signal ? [options.signal] : []),
            ]),
            authorize(current, execution) {
              assertCurrent(store);
              admitFileWrite(
                binding,
                current,
                execution.context,
                conversationId,
                parsed.data.filename,
                parsed.data.expected_size,
                execution.now,
              );
            },
            apply(draft, execution) {
              const id = execution.uuid();
              if (Object.hasOwn(draft.files, id)) return invalidMemoryState();
              const timestamp = new Date(execution.now).toISOString();
              const row: C.CommsFile = {
                id,
                org_id: execution.context.org_id,
                conversation_id: conversationId,
                creator_id: execution.context.user_id,
                purpose: "comms_attachment",
                ...parsed.data,
                actual_size: null,
                media_type: null,
                state: "awaiting_upload",
                failure_code: null,
                is_deleted: false,
                created_at: timestamp,
                updated_at: timestamp,
              };
              draft.files[id] = row;
              return {
                kind: "commit",
                value: row,
                version_keys: [fileKey(id)],
                publications: [],
              };
            },
          });
          return result.value;
        },
        async uploadAttachment(conversationId, fileId, bytes, options) {
          active(options);
          if (!(bytes instanceof Blob)) return invalidInput();
          // Read ownership/shape before acquiring bytes; recheck all current rights at commit.
          const initial = handle.read((state, context) => {
            const row = fileRow(state, context, conversationId, fileId);
            if (row.creator_id !== context.user_id) return capabilityDenied();
            if (
              row.state !== "awaiting_upload" ||
              bytes.size !== row.expected_size
            )
              return invalidInput();
            return row;
          });
          const progress = (loaded_bytes: number) => {
            try {
              options?.on_progress?.({
                loaded_bytes,
                total_bytes: initial.expected_size,
              });
            } catch {
              // A progress observer cannot accept or roll back a command.
            }
          };
          let next = committed;
          const command: MemoryCommand<Blob, C.CommsFile> = {
            signal: AbortSignal.any([
              anchor.lifetimeSignal,
              ...(options?.signal ? [options.signal] : []),
            ]),
            async prepare(signal) {
              progress(0);
              if (signal.aborted) return cancelled();
              let buffer: ArrayBuffer;
              try {
                buffer = await bytes.arrayBuffer();
              } catch {
                if (signal.aborted) return cancelled();
                throw Object.assign(
                  new Error("OpenComms local byte read failed"),
                  {
                    kind: "network" as const,
                  },
                );
              }
              if (signal.aborted) return cancelled();
              if (buffer.byteLength !== initial.expected_size)
                return invalidInput();
              return new Blob([buffer]);
            },
            authorize(current, execution, prepared) {
              assertCurrent(store);
              const row = fileRow(
                current,
                execution.context,
                conversationId,
                fileId,
              );
              if (row.creator_id !== execution.context.user_id)
                return capabilityDenied();
              if (
                row.state !== "awaiting_upload" ||
                prepared.size !== row.expected_size
              )
                return invalidInput();
              admitFileWrite(
                binding,
                current,
                execution.context,
                conversationId,
                row.filename,
                prepared.size,
                execution.now,
              );
            },
            apply(draft, execution, prepared) {
              const row = draft.files[fileId];
              const extension = row.filename.split(".").at(-1)!.toLowerCase();
              row.actual_size = prepared.size;
              row.media_type = mediaTypes[extension];
              row.state = "ready";
              row.failure_code = null;
              row.updated_at = new Date(execution.now).toISOString();
              next = new Map(committed);
              next.set(fileId, {
                proof: { ...row },
                bytes: prepared.slice(0, prepared.size, row.media_type),
              });
              return {
                kind: "commit",
                value: row,
                version_keys: [fileKey(fileId)],
                publications: [],
              };
            },
            finalize: () => {
              committed = next;
            },
          };
          const result = await handle.command(command);
          progress(initial.expected_size);
          return result.value;
        },
        async downloadAttachment(conversationId, fileId, options) {
          active(options);
          return handle.read((state, context) => {
            const row = fileRow(state, context, conversationId, fileId);
            if (!conversationSettings(state, conversationId).file_downloads)
              return capabilityDenied();
            const entry = committed.get(fileId);
            if (!entry || !matches(entry, row) || !row.media_type)
              return fileNotFound();
            return {
              bytes: entry.bytes,
              filename: row.filename,
              media_type: row.media_type,
            };
          });
        },
      };
    },
    dispose() {
      if (retired) return;
      anchor.dispose();
    },
  };
  return resources;
}
