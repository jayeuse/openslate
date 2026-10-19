import {
  sendMessageRequestSchema,
  sendReplyRequestSchema,
} from "../contract/schemas";
import type {
  CommsContext,
  SendMessageRequest,
  Settings,
} from "../contract/types";
import type { MemoryCommsState } from "../memory/model";
import {
  activePerson,
  conversationAccess,
  directBlocked,
  notFound,
  ownedConversation,
  policyFailure,
} from "./access";
import { capabilityCheck } from "./capabilities";
import { invalidInput, resolveSettings } from "./settings";

export function postDenied(): never {
  return policyFailure({
    status: 403,
    body: {
      detail: { code: "comms_post_denied", message: "Posting is not allowed" },
    },
  });
}

function postingContext(
  world: MemoryCommsState,
  context: CommsContext,
  id: string,
  now: number,
) {
  if (!Number.isFinite(now)) return invalidInput();
  const conversation = ownedConversation(world, context, id);
  const check = capabilityCheck(world, context, id);
  if (check.conversation_level === "none") return notFound();
  const settings = resolveSettings(
    world,
    conversation.kind === "channel"
      ? { kind: "channel", id }
      : { kind: "workspace" },
  ).effective;
  if (
    check.membership_role === "guest" ||
    conversation.archived_at ||
    settings.locked ||
    (settings.restricted_person_ids.includes(context.user_id) &&
      (!settings.restriction_until ||
        Date.parse(settings.restriction_until) > now))
  )
    return postDenied();
  if (
    conversation.kind === "direct" &&
    Object.keys(world.members[id] ?? {}).some((userId) =>
      directBlocked(world, context.user_id, userId),
    )
  )
    return postDenied();
  return { conversation, check, settings };
}

function requireCapability(allowed: boolean) {
  if (!allowed)
    policyFailure({
      status: 403,
      body: {
        detail: {
          code: "comms_capability_denied",
          message: "Capability required",
        },
      },
    });
}

function validateMentions(
  world: MemoryCommsState,
  context: CommsContext,
  id: string,
  content: Pick<
    SendMessageRequest,
    "mention_user_ids" | "mentions_channel" | "mentions_here"
  >,
  settings: Settings,
) {
  const mentions = content.mention_user_ids ?? [];
  const check = capabilityCheck(world, context, id);
  if (content.mentions_channel || content.mentions_here)
    requireCapability(check.capabilities.mentionChannel.allowed);
  if (
    settings.mention_limit > 0 &&
    mentions.length +
      Number(Boolean(content.mentions_channel)) +
      Number(Boolean(content.mentions_here)) >
      settings.mention_limit
  )
    return invalidInput();
  for (const userId of mentions) {
    const target = world.people[userId];
    if (
      !target?.active ||
      target.org_id !== context.org_id ||
      !world.members[id]?.[userId] ||
      conversationAccess(world, { ...context, user_id: userId }, id).level ===
        "none"
    )
      return invalidInput();
  }
}

export function admitSend(
  world: MemoryCommsState,
  context: CommsContext,
  conversationId: string,
  input: unknown,
  options: { now: number; parent_id?: string | null },
) {
  const { conversation, check, settings } = postingContext(
    world,
    context,
    conversationId,
    options.now,
  );
  if (
    options.parent_id
      ? !check.capabilities.reply.allowed
      : !["post", "manage"].includes(check.conversation_level)
  )
    return postDenied();
  if (
    !options.parent_id &&
    conversation.kind === "channel" &&
    (settings.mode === "thread-first" ||
      (settings.mode === "announcements" &&
        check.conversation_level !== "manage"))
  )
    return postDenied();
  if (options.parent_id) {
    const root = world.messages[options.parent_id];
    if (
      !root ||
      root.org_id !== context.org_id ||
      root.conversation_id !== conversationId ||
      root.parent_id !== null
    )
      return notFound();
    const thread = Object.values(world.threads).find(
      (t) =>
        t.root_message_id === root.id &&
        t.org_id === context.org_id &&
        t.conversation_id === conversationId,
    );
    if (thread?.locked || thread?.archived) return postDenied();
  }
  const parsed = (
    options.parent_id ? sendReplyRequestSchema : sendMessageRequestSchema
  ).safeParse(input);
  if (!parsed.success) {
    if (
      parsed.error.issues.every(
        (issue) => issue.code === "custom" && issue.path.length === 0,
      )
    )
      return policyFailure({
        status: 422,
        body: {
          detail: { code: "comms_message_empty", message: "Message is empty" },
        },
      });
    return invalidInput();
  }
  const request = parsed.data;
  const person = activePerson(world, context);
  if (settings.require_record_link && !request.record_ids.length)
    return invalidInput();
  if (request.record_ids.length)
    requireCapability(check.capabilities.linkRecords.allowed);
  for (const id of request.record_ids) {
    const record = world.records[id];
    if (
      !record ||
      record.org_id !== context.org_id ||
      world.modules[record.module_id]?.org_id !== context.org_id ||
      !person.readable_module_ids.includes(record.module_id) ||
      (settings.allowed_record_modules.length &&
        !settings.allowed_record_modules.includes(record.module_id))
    )
      return invalidInput();
  }
  if (request.attachment_ids.length)
    requireCapability(check.capabilities.attachFiles.allowed);
  for (const id of request.attachment_ids) {
    const file = world.files[id];
    const extension = file?.filename.split(".").at(-1)?.toLowerCase();
    const platformTypes = ["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "pptx"];
    if (
      !file ||
      file.org_id !== context.org_id ||
      file.conversation_id !== conversationId ||
      file.creator_id !== context.user_id ||
      file.is_deleted ||
      file.state !== "ready" ||
      !file.actual_size ||
      file.actual_size > (settings.max_file_size_mb || 10) * 1024 * 1024 ||
      !extension ||
      !platformTypes.includes(extension) ||
      (settings.allowed_file_types.length &&
        !settings.allowed_file_types.some((type) => type === extension))
    )
      return invalidInput();
  }
  if (request.reply_to_id) {
    const quote = world.messages[request.reply_to_id];
    if (
      !quote ||
      quote.org_id !== context.org_id ||
      quote.conversation_id !== conversationId ||
      quote.deleted_at
    )
      return notFound();
  }
  validateMentions(world, context, conversationId, request, settings);
  const own = Object.values(world.messages).filter(
    (m) => m.org_id === context.org_id && m.author_id === context.user_id,
  );
  const recent = own.filter(
    (m) => Date.parse(m.created_at) > options.now - 10_000,
  );
  if (recent.length >= 20)
    return policyFailure({
      status: 429,
      retry_after_seconds: Math.max(
        1,
        Math.ceil(
          (Math.min(...recent.map((m) => Date.parse(m.created_at))) +
            10_000 -
            options.now) /
            1000,
        ),
      ),
      body: {
        detail: {
          code: "comms_rate_limited",
          message: "Wait before sending again",
        },
      },
    });
  const latest = Math.max(
    -Infinity,
    ...own
      .filter((m) => m.conversation_id === conversationId)
      .map((m) => Date.parse(m.created_at)),
  );
  const remaining = latest + settings.slow_mode_seconds * 1000 - options.now;
  if (settings.slow_mode_seconds > 0 && remaining > 0)
    return policyFailure({
      status: 429,
      retry_after_seconds: Math.ceil(remaining / 1000),
      body: {
        detail: {
          code: "comms_slow_mode",
          message: "Wait before sending again",
        },
      },
    });
  return request;
}

export function assertMessageChange(
  world: MemoryCommsState,
  context: CommsContext,
  messageId: string,
  action: "edit" | "delete" | "restore",
  now: number,
) {
  const message = world.messages[messageId];
  if (!message || message.org_id !== context.org_id) return notFound();
  const { check, settings } = postingContext(
    world,
    context,
    message.conversation_id,
    now,
  );
  const own = message.author_id === context.user_id;
  if (action === "restore") {
    requireCapability(check.capabilities.deleteOthersMessages.allowed);
    return;
  }
  if (message.deleted_at) return notFound();
  if (action === "edit" && !own) return postDenied();
  if (!own) requireCapability(check.capabilities.deleteOthersMessages.allowed);
  else if (
    check.conversation_level === "read" &&
    !check.capabilities.reply.allowed
  )
    return postDenied();
  const minutes =
    action === "edit"
      ? settings.edit_window_minutes
      : settings.delete_window_minutes;
  if (
    own &&
    minutes > 0 &&
    now - Date.parse(message.created_at) > minutes * 60_000
  )
    return postDenied();
}

export function assertReaction(
  world: MemoryCommsState,
  context: CommsContext,
  messageId: string,
  emoji: string,
) {
  const message = world.messages[messageId];
  if (!message || message.org_id !== context.org_id || message.deleted_at)
    return notFound();
  const check = capabilityCheck(world, context, message.conversation_id);
  if (check.conversation_level === "none") return notFound();
  requireCapability(check.capabilities.react.allowed);
  const conversation = world.conversations[message.conversation_id];
  const settings = resolveSettings(
    world,
    conversation.kind === "channel"
      ? { kind: "channel", id: conversation.id }
      : { kind: "workspace" },
  ).effective;
  if (!settings.allowed_reactions.includes(emoji)) return invalidInput();
}
