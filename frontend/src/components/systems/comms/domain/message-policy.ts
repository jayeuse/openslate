import type { Person, Role } from "../../access/domain/model";
import type { SampleRecord } from "../../shared/data/sample-data";
import type { Category, Channel, LocalAttachment, Message } from "./model";
import {
  resolveCommsSettings,
  resolveCommsPermission,
  type CommsConfiguration,
  type CommsPermission,
} from "./configuration";
import { messageAuthorId } from "./model";
export interface CommsMessageInput {
  config: CommsConfiguration;
  person?: Person;
  channel?: Channel;
  categories: Category[];
  people?: Person[];
  roles?: Role[];
  messages: Message[];
  text: string;
  files: LocalAttachment[];
  record?: SampleRecord;
  now?: number;
  kind: "post" | "reply" | "thread";
  system?: boolean;
}
export interface CommsMessageChangeInput {
  config: CommsConfiguration;
  person?: Person;
  channel?: Channel;
  categories: Category[];
  people?: Person[];
  message: Message;
  kind: "edit" | "delete";
  now?: number;
}
export function isCommsManager(
  input: Pick<
    CommsMessageInput,
    "config" | "person" | "channel" | "categories"
  >,
): boolean {
  const { person } = input;
  if (!person?.active) return false;
  const { values } = resolveCommsSettings(
    input.config,
    input.channel,
    input.categories,
  );
  return (
    person.id === "sample-eli" ||
    person.role === "sample-admin" ||
    values.ownerId === person.id ||
    values.moderatorIds.includes(person.id)
  );
}
function unavailable(
  input: Pick<
    CommsMessageInput,
    "config" | "person" | "channel" | "categories"
  >,
): string | null {
  if (!input.person?.active) return "An active person is required.";
  if (input.channel?.archived) return "This channel is archived.";
  const access = resolveCommsPermission(input.config, input, "viewChannel");
  if (!access.allowed) return "You cannot access this channel.";
  if (
    resolveCommsSettings(input.config, input.channel, input.categories).values
      .locked
  )
    return "This channel is locked.";
  return null;
}
export function validateCommsMessage(input: CommsMessageInput): string | null {
  const blocked = unavailable(input);
  if (blocked) return blocked;
  const {
    config,
    person,
    channel,
    categories,
    text,
    files,
    record,
    kind,
    people = [],
    roles = [],
    messages,
  } = input;
  const now = input.now ?? Date.now();
  const settings = resolveCommsSettings(config, channel, categories).values;
  const can = (action: CommsPermission) =>
    resolveCommsPermission(config, input, action).allowed;
  if (
    settings.restrictedPersonIds.includes(person!.id) &&
    (settings.restrictionUntil === 0 || settings.restrictionUntil > now)
  )
    return "Posting is temporarily restricted for this person.";
  if (
    !can(
      kind === "post" ? "post" : kind === "thread" ? "createThread" : "reply",
    )
  )
    return "You do not have permission to send this message.";
  if (input.system && !settings.systemMessages)
    return "System messages are disabled in this channel.";
  if (channel && kind === "post" && settings.mode === "thread-first")
    return "Start a thread in this channel.";
  if (
    kind === "post" &&
    channel &&
    settings.mode === "announcements" &&
    !isCommsManager(input)
  )
    return "Only channel managers can post announcements. You can reply in threads.";
  if (!text.trim() && !files.length && !record)
    return "Write a message, attach a file, or link a record.";
  if (settings.requireRecordLink && !record)
    return "Link a record before sending.";
  if (record && !can("linkRecords"))
    return "You do not have permission to link records.";
  // Every record in the current prototype belongs to the Service requests module.
  if (
    record &&
    settings.allowedRecordModules.length &&
    !settings.allowedRecordModules.includes("Service requests")
  )
    return "The Service requests record module is not allowed in this channel.";
  if (files.length && !can("attachFiles"))
    return "You do not have permission to attach files.";
  for (const file of files) {
    if (
      settings.maxFileSizeMb > 0 &&
      file.size > settings.maxFileSizeMb * 1024 * 1024
    )
      return `The file ${file.name} exceeds the size limit.`;
    const name = file.name.toLowerCase(),
      mime = file.type.toLowerCase();
    if (
      settings.allowedFileTypes.length &&
      !settings.allowedFileTypes.some((type) => {
        const rule = type.trim().toLowerCase();
        return (
          rule === "*" ||
          (rule.startsWith(".")
            ? name.endsWith(rule)
            : rule.endsWith("/*")
              ? mime.startsWith(rule.slice(0, -1))
              : rule.includes("/")
                ? mime === rule
                : name.endsWith(`.${rule}`))
        );
      })
    )
      return `The file type for ${file.name} is not allowed.`;
  }
  const mentions = text.match(/@[\p{L}\p{N}_-]+/gu) ?? [];
  if (settings.mentionLimit > 0 && mentions.length > settings.mentionLimit)
    return "This message exceeds the mention limit.";
  if (/@(everyone|here)\b/i.test(text) && !can("mentionEveryone"))
    return "You do not have permission to mention everyone.";
  if (
    roles.some((role) => text.includes(`@${role.name}`)) &&
    !can("mentionRoles")
  )
    return "You do not have permission to mention roles.";
  if (
    people.some((member) => text.includes(`@${member.name}`)) &&
    !can("mentionPeople")
  )
    return "You do not have permission to mention people.";
  if (settings.slowModeSeconds > 0) {
    const latest = messages
      .filter((message) => messageAuthorId(message, people) === person!.id)
      .reduce((last, message) => Math.max(last, message.created), -Infinity);
    if (now - latest < settings.slowModeSeconds * 1000)
      return `Slow mode: wait ${Math.ceil((settings.slowModeSeconds * 1000 - (now - latest)) / 1000)} seconds before sending.`;
  }
  return null;
}
export function validateCommsMessageChange(
  input: CommsMessageChangeInput,
): string | null {
  const blocked = unavailable(input);
  if (blocked) return blocked;
  const own =
    messageAuthorId(input.message, input.people ?? []) === input.person!.id;
  if (input.kind === "edit" && !own)
    return "You can only edit your own messages.";
  const action =
    input.kind === "edit"
      ? "editMessages"
      : own
        ? "deleteMessages"
        : "deleteOthersMessages";
  if (!resolveCommsPermission(input.config, input, action).allowed)
    return `You do not have permission to ${input.kind} this message.`;
  const settings = resolveCommsSettings(
    input.config,
    input.channel,
    input.categories,
  ).values;
  const minutes =
    input.kind === "edit"
      ? settings.editWindowMinutes
      : settings.deleteWindowMinutes;
  if (
    minutes > 0 &&
    (input.now ?? Date.now()) - input.message.created > minutes * 60000
  )
    return `The ${input.kind} window has expired.`;
  return null;
}
