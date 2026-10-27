import { z } from "zod";
import { ApiError, apiFetch, type ApiRequestInit } from "@/lib/api";

const safeCodes: Record<string, { status: number; message: string }> = {
  board_archived: {
    status: 409,
    message: "Restore the board before continuing",
  },
  board_not_archived: {
    status: 409,
    message: "The board is not archived",
  },
  stale_revision: {
    status: 409,
    message: "Board changed; reload before saving",
  },
  board_invalid: { status: 409, message: "Unable to save the board" },
  board_scope_fixed: {
    status: 409,
    message:
      "Company and department boards follow the organization and their department",
  },
  board_name_fixed: {
    status: 409,
    message: "A department board has the name of its department",
  },
  group_unavailable: {
    status: 409,
    message: "A selected group is unavailable",
  },
  board_groups_conflict: {
    status: 409,
    message: "Board groups changed; reload",
  },
  board_purge_conflict: {
    status: 409,
    message: "Board dependencies changed; get a new review",
  },
  purge_disabled: {
    status: 403,
    message: "Delete forever is turned off for this installation.",
  },
  purge_requires_closed: {
    status: 409,
    message: "Archive the board before deleting it",
  },
  confirmation_name_mismatch: {
    status: 422,
    message: "The board name did not match",
  },
  challenge_expired: {
    status: 409,
    message: "The review expired; get a new review",
  },
  challenge_not_found: {
    status: 404,
    message: "The review is unavailable; get a new review",
  },
  challenge_binding_mismatch: {
    status: 403,
    message: "The review is unavailable; get a new review",
  },
  challenge_exhausted: {
    status: 409,
    message: "The review is unavailable; get a new review",
  },
};

export function throwSafeBoardError(status: number, detail: unknown): never {
  if (
    (status === 404 || status === 403) &&
    (detail === "Board not found" || detail === "Forbidden")
  ) {
    throw new ApiError(status, detail);
  }
  const parsed = z.object({ code: z.string() }).passthrough().safeParse(detail);
  if (parsed.success) {
    const safe = safeCodes[parsed.data.code];
    if (safe && safe.status === status) {
      throw new ApiError(
        status,
        safe.message,
        {
          code: parsed.data.code,
          message: safe.message,
        },
        parsed.data.code,
      );
    }
  }
  throw new ApiError(status, "Request could not be completed");
}

export async function safeBoardJson<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init: ApiRequestInit = {},
): Promise<z.output<Schema>> {
  try {
    return await apiFetch(path, schema, { cache: "no-store", ...init });
  } catch (error) {
    if (error instanceof ApiError)
      return throwSafeBoardError(error.status, error.details);
    throw error;
  }
}

export function queryString(values: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    query.set(key, String(value));
  return query.toString();
}
