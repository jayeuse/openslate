import { z } from "zod";
import { ApiError, apiFetch, type ApiRequestInit } from "@/lib/api";

const safeCodes: Record<string, { status: number; message: string }> = {
  board_bundle_too_large: {
    status: 413,
    message: "Board configuration is too large",
  },
  board_bundle_invalid: {
    status: 422,
    message: "Board configuration is invalid",
  },
  board_source_unavailable: {
    status: 409,
    message: "A Board source is unavailable",
  },
  board_import_conflict: { status: 409, message: "Unable to create Board" },
  board_archived: {
    status: 409,
    message: "Restore the Board before continuing",
  },
  board_not_archived: {
    status: 409,
    message: "The Board is not archived",
  },
  stale_revision: {
    status: 409,
    message: "Board changed; reload before saving",
  },
  department_unavailable: {
    status: 409,
    message: "The selected department is unavailable",
  },
  board_invalid: { status: 409, message: "Unable to save Board" },
  template_limit_reached: {
    status: 409,
    message: "The workspace has 50 active templates",
  },
  template_conflict: { status: 409, message: "Unable to save Board template" },
  template_invalid: { status: 409, message: "Saved Board template is invalid" },
  home_board_archived: {
    status: 409,
    message: "Restore the Board before setting it as home",
  },
  personal_state_conflict: {
    status: 409,
    message: "Board preferences changed; retry",
  },
  board_purge_conflict: {
    status: 409,
    message: "Board dependencies changed; get a new review",
  },
  purge_disabled: {
    status: 409,
    message: "Permanent Board deletion is disabled",
  },
  purge_requires_closed: {
    status: 409,
    message: "Archive the Board before deletion",
  },
  confirmation_name_mismatch: {
    status: 409,
    message: "The Board ID confirmation did not match",
  },
  challenge_expired: {
    status: 409,
    message: "The review expired; get a new review",
  },
  challenge_not_found: {
    status: 409,
    message: "The review is unavailable; get a new review",
  },
  challenge_binding_mismatch: {
    status: 409,
    message: "The review is unavailable; get a new review",
  },
  challenge_exhausted: {
    status: 409,
    message: "The review is unavailable; get a new review",
  },
};

export function throwSafeBoardError(status: number, detail: unknown): never {
  if (
    status === 404 &&
    (detail === "Board not found" || detail === "Board template not found")
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
