import { z } from "zod";
import { ApiContractError, ApiError, apiFetch, apiRequest } from "@/lib/api";

/**
 * Record-date sources (BR57, BE8): a module's date or datetime field shown
 * on a calendar. A board's sources are read by its readers (only those whose
 * module the viewer reads) and changed by its managers; a person's own
 * sources belong to My calendar.
 */

const uuid = z.string().uuid();

const sourceWire = z
  .object({
    id: uuid,
    module_id: uuid,
    module_name: z.string().min(1),
    department_id: uuid,
    date_field_id: uuid,
    field_name: z.string().min(1),
    field_type: z.enum(["date", "datetime"]),
    position: z.number().int().min(0),
  })
  .strict()
  .transform((source) => ({
    id: source.id,
    moduleId: source.module_id,
    moduleName: source.module_name,
    departmentId: source.department_id,
    dateFieldId: source.date_field_id,
    fieldName: source.field_name,
    fieldType: source.field_type,
    position: source.position,
  }));
const sourceListWire = z.object({ items: z.array(sourceWire).max(5) }).strict();

export type CalendarSource = z.output<typeof sourceWire>;
export type CalendarSourceInput = { moduleId: string; dateFieldId: string };

const sourceInput = z
  .object({ moduleId: uuid, dateFieldId: uuid })
  .strict()
  .transform(({ moduleId, dateFieldId }) => ({
    module_id: moduleId,
    date_field_id: dateFieldId,
  }));

type Owner = "board" | "me";

/** Plain sentences for the refusals; none names a module the viewer may not read. */
function refusalMessage(code: string, owner: Owner): string | null {
  switch (code) {
    case "calendar_source_limit":
      return `${owner === "board" ? "This calendar" : "My calendar"} already has 5 record sources. Remove one to add another.`;
    case "calendar_source_exists":
      return "This date field is already a record source.";
    case "calendar_source_unavailable":
      return "That module or date field is no longer available.";
    case "calendar_source_conflict":
      return "The calendar changed. Try again.";
    default:
      return null;
  }
}

function safeError(error: unknown, owner: Owner): unknown {
  if (!(error instanceof ApiError)) return error;
  const detail = z
    .object({ code: z.string() })
    .passthrough()
    .safeParse(error.details);
  const message = detail.success
    ? refusalMessage(detail.data.code, owner)
    : null;
  if (message)
    return new ApiError(
      error.status,
      message,
      { code: detail.success ? detail.data.code : undefined },
      detail.success ? (detail.data.code as ApiError["code"]) : undefined,
    );
  return new ApiError(error.status, "Request could not be completed");
}

function sourcesPath(owner: Owner, boardId?: string): string {
  return owner === "board"
    ? `/boards/${uuid.parse(boardId)}/calendar-sources`
    : "/me/calendar-sources";
}

async function listSources(path: string, owner: Owner) {
  try {
    const { items } = await apiFetch(path, sourceListWire, {
      cache: "no-store",
    });
    return items;
  } catch (error) {
    throw safeError(error, owner);
  }
}

async function addSource(
  path: string,
  owner: Owner,
  input: CalendarSourceInput,
): Promise<CalendarSource> {
  const body = sourceInput.parse(input);
  try {
    const source = await apiFetch(path, sourceWire, {
      method: "POST",
      cache: "no-store",
      body: JSON.stringify(body),
    });
    if (
      source.moduleId !== body.module_id ||
      source.dateFieldId !== body.date_field_id
    )
      throw new ApiContractError();
    return source;
  } catch (error) {
    throw safeError(error, owner);
  }
}

async function removeSource(path: string, owner: Owner): Promise<void> {
  const response = await apiRequest(path, {
    method: "DELETE",
    cache: "no-store",
  });
  if (response.ok) {
    if (response.status !== 204) throw new ApiContractError();
    return;
  }
  const body: unknown = await response.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "detail" in body ? body.detail : null;
  throw safeError(new ApiError(response.status, "", detail), owner);
}

export function listBoardCalendarSources(
  boardId: string,
): Promise<CalendarSource[]> {
  return listSources(sourcesPath("board", boardId), "board");
}

export function addBoardCalendarSource(
  boardId: string,
  input: CalendarSourceInput,
): Promise<CalendarSource> {
  return addSource(sourcesPath("board", boardId), "board", input);
}

export function removeBoardCalendarSource(
  boardId: string,
  sourceId: string,
): Promise<void> {
  return removeSource(
    `${sourcesPath("board", boardId)}/${uuid.parse(sourceId)}`,
    "board",
  );
}

/** Add to My calendar (BR57): a copy in the person's own sources. */
export function addMyCalendarSource(
  input: CalendarSourceInput,
): Promise<CalendarSource> {
  return addSource(sourcesPath("me"), "me", input);
}

/** My calendar's own sources (BR57): only those the server still shows. */
export function listMyCalendarSources(): Promise<CalendarSource[]> {
  return listSources(sourcesPath("me"), "me");
}

export function removeMyCalendarSource(sourceId: string): Promise<void> {
  return removeSource(`${sourcesPath("me")}/${uuid.parse(sourceId)}`, "me");
}
