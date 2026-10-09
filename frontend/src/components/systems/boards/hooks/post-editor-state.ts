import { ApiError } from "@/lib/api";
import type {
  BoardPost,
  BoardPostPage,
  BoardPostPatchInput,
} from "../adapters/board-posts-api";
import type { BoardMyAccess } from "../adapters/board-tools-api";

export type PostEditorForm = {
  title: string;
  body: string;
  links: BoardPost["links"];
  pinned: boolean;
  expiresLocal: string;
};

export type PostEditorState = {
  key: string;
  status: "loading" | "ready" | "error" | "denied";
  access: BoardMyAccess | null;
  page: BoardPostPage | null;
  boardRevision: number;
  selected: BoardPost | null;
  form: PostEditorForm | null;
  displayed: BoardPost | null;
  pending: boolean;
  attachmentPending: boolean;
  recordLinkPending: boolean;
  conflict: boolean;
  error: string | null;
  notice: string | null;
  scheduleLocal: string;
  scheduleError: string | null;
  expiryError: string | null;
};

export type PostScheduleTimeResult =
  | { ok: true; publishAt: string }
  | {
      ok: false;
      reason: "required" | "invalid" | "past" | "after_expiration";
    };

export function emptyState(
  key: string,
  boardRevision: number,
): PostEditorState {
  return {
    key,
    status: "loading",
    access: null,
    page: null,
    boardRevision,
    selected: null,
    form: null,
    displayed: null,
    pending: false,
    attachmentPending: false,
    recordLinkPending: false,
    conflict: false,
    error: null,
    notice: null,
    scheduleLocal: "",
    scheduleError: null,
    expiryError: null,
  };
}

function localTimeValue(timestamp: string | null): string {
  if (timestamp === null) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = date.getSeconds() === 0 ? "" : `:${pad(date.getSeconds())}`;
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${seconds}`;
}

export function postLocalScheduleValue(item: BoardPost | null): string {
  return item?.status === "scheduled" ? localTimeValue(item.publishAt) : "";
}

function localTime(value: string): Date | null {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
      value,
    );
  const date = new Date(value);
  if (!parts || !Number.isFinite(date.getTime())) return null;
  const [, year, month, day, hour, minute, second = "0", fraction = ""] = parts;
  const milliseconds = Number(fraction.padEnd(3, "0") || "0");
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() + 1 !== Number(month) ||
    date.getDate() !== Number(day) ||
    date.getHours() !== Number(hour) ||
    date.getMinutes() !== Number(minute) ||
    date.getSeconds() !== Number(second) ||
    date.getMilliseconds() !== milliseconds
  )
    return null;
  return date;
}

export function postExpiryTimeToUtc(value: string): string | null {
  if (!value) return null;
  const date = localTime(value);
  if (!date) throw new Error("Invalid local expiry time");
  return date.toISOString();
}

export function postScheduleTimeToUtc(
  value: string,
  now: number = Date.now(),
  expiresAt: string | null = null,
): PostScheduleTimeResult {
  if (!value) return { ok: false, reason: "required" };
  const date = localTime(value);
  if (!date) return { ok: false, reason: "invalid" };
  if (date.getTime() <= now) return { ok: false, reason: "past" };
  const expiration = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  if (Number.isFinite(expiration) && date.getTime() >= expiration)
    return { ok: false, reason: "after_expiration" };
  return { ok: true, publishAt: date.toISOString() };
}

export function postCancellationPatch(
  selected: BoardPost,
  boardRevision: number,
): BoardPostPatchInput {
  if (selected.status !== "scheduled" || selected.postRevision === null)
    throw new Error("Not a scheduled draft");
  return {
    boardRevision,
    postRevision: selected.postRevision,
    title: selected.title,
    body: selected.body,
  };
}

export function scheduleTimeError(
  reason: Exclude<PostScheduleTimeResult, { ok: true }>["reason"],
): string {
  switch (reason) {
    case "required":
      return "Choose a publication date and time.";
    case "invalid":
      return "Choose a valid local time. Clock changes can make some local times unavailable.";
    case "past":
      return "Choose a publication time in the future.";
    case "after_expiration":
      return "Choose a publication time before this post expires.";
  }
}

export function editorStateForKey(
  state: PostEditorState,
  key: string,
  boardRevision: number,
): PostEditorState {
  return state.key === key ? state : emptyState(key, boardRevision);
}

export function isDenial(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function editorFailure(
  state: PostEditorState,
  error: unknown,
): PostEditorState {
  if (isDenial(error))
    return {
      ...emptyState(state.key, state.boardRevision),
      status: "denied",
      error: "Post editing is unavailable. Check your Board access.",
    };
  if (error instanceof ApiError && error.status === 409)
    return {
      ...state,
      pending: false,
      conflict: true,
      error: `${error.message}. Your text has been kept; refresh drafts to review the latest version.`,
    };
  return {
    ...state,
    pending: false,
    error: "Post request failed. Try again.",
  };
}

export function formFor(item: BoardPost): PostEditorForm {
  return {
    title: item.title,
    body: item.body,
    links: item.links.map((link) => ({ ...link })),
    pinned: item.pinned,
    expiresLocal: localTimeValue(item.expiresAt),
  };
}

export function validPostLinks(links: PostEditorForm["links"]): boolean {
  if (links.length > 20) return false;
  return links.every(({ label, url }) => {
    const authority = /^https?:\/\/([^/?#]*)/i.exec(url.trim())?.[1];
    if (
      !label.trim() ||
      label.trim().length > 100 ||
      !url.trim() ||
      url.trim().length > 2048 ||
      !authority ||
      authority.includes("@") ||
      /[\\\u0000-\u001f\u007f]/.test(url)
    )
      return false;
    try {
      const parsed = new URL(url.trim());
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        !parsed.username &&
        !parsed.password &&
        parsed.href.length <= 2048
      );
    } catch {
      return false;
    }
  });
}

function linksEqual(
  a: PostEditorForm["links"],
  b: BoardPost["links"],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (link, index) =>
        link.label === b[index].label && link.url === b[index].url,
    )
  );
}

export function samePostContent(left: BoardPost, right: BoardPost): boolean {
  return (
    left.id === right.id &&
    left.boardId === right.boardId &&
    left.authorId === right.authorId &&
    left.title === right.title &&
    left.body === right.body &&
    linksEqual(left.links, right.links) &&
    left.status === right.status &&
    left.publishAt === right.publishAt &&
    left.expiresAt === right.expiresAt &&
    left.pinned === right.pinned
  );
}

export function dirty(
  form: PostEditorForm | null,
  item: BoardPost | null,
): boolean {
  if (!form) return false;
  if (!item) return true;
  const original = formFor(item);
  return (
    form.title !== original.title ||
    form.body !== original.body ||
    !linksEqual(form.links, original.links) ||
    form.pinned !== original.pinned ||
    form.expiresLocal !== original.expiresLocal
  );
}

export function valid(form: PostEditorForm | null): form is PostEditorForm {
  return (
    form !== null &&
    form.title.trim().length >= 1 &&
    form.title.trim().length <= 100 &&
    form.body.trim().length >= 1 &&
    form.body.trim().length <= 2000 &&
    validPostLinks(form.links)
  );
}

export function postPatchForForm(
  selected: BoardPost,
  form: PostEditorForm,
  boardRevision: number,
  canManage = false,
): BoardPostPatchInput {
  if (selected.postRevision === null) throw new Error("Not an editable draft");
  return {
    boardRevision,
    postRevision: selected.postRevision,
    title: form.title,
    body: form.body,
    ...(!linksEqual(form.links, selected.links) ? { links: form.links } : {}),
    ...(canManage && form.pinned !== selected.pinned
      ? { pinned: form.pinned }
      : {}),
    ...(form.expiresLocal !== localTimeValue(selected.expiresAt)
      ? { expiresAt: postExpiryTimeToUtc(form.expiresLocal) }
      : {}),
  };
}

export function resolveEditorRefresh(
  state: PostEditorState,
  access: BoardMyAccess,
  page: BoardPostPage,
  verified: BoardPost | null,
  hadSelection: boolean,
): PostEditorState {
  const currentDraft = verified?.id === state.selected?.id ? verified : null;
  const revisionChanged =
    currentDraft !== null &&
    currentDraft.postRevision !== state.selected?.postRevision;
  const conflict =
    currentDraft !== null &&
    (state.conflict ||
      (revisionChanged &&
        (dirty(state.form, state.selected) ||
          state.scheduleLocal !== postLocalScheduleValue(state.selected))));
  return {
    ...state,
    status: "ready",
    access,
    page,
    boardRevision: conflict ? state.boardRevision : page.boardRevision,
    selected: conflict ? state.selected : currentDraft,
    form: currentDraft
      ? revisionChanged && !conflict
        ? formFor(currentDraft)
        : state.form
      : hadSelection
        ? null
        : state.form,
    scheduleLocal: currentDraft
      ? revisionChanged && !conflict
        ? postLocalScheduleValue(currentDraft)
        : state.scheduleLocal
      : hadSelection
        ? ""
        : state.scheduleLocal,
    scheduleError: revisionChanged && !conflict ? null : state.scheduleError,
    conflict,
    pending: false,
    error: null,
    notice: conflict ? null : state.notice,
  };
}
