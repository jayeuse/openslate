import { z } from "zod";
import { ApiError } from "@/lib/api";
import type { LayoutIssueCode } from "../domain/dashboard-grid";

const layoutInvalidDetailSchema = z
  .object({
    code: z.literal("dashboard_layout_invalid"),
    message: z.string().optional(),
    errors: z
      .array(
        z
          .object({
            index: z.number().int().min(0),
            code: z.enum(["overlap", "outside_grid", "size_not_allowed"]),
            message: z.string(),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();

export type OpenViewDashboardLayoutIssue = {
  /** 0-based index in the saved widget list. */
  index: number;
  code: LayoutIssueCode;
  message: string;
};

/** The widgets a 422 layout refusal names, or null for any other error. */
export function getOpenViewDashboardLayoutIssues(
  error: unknown,
): OpenViewDashboardLayoutIssue[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const parsed = layoutInvalidDetailSchema.safeParse(error.details);
  if (!parsed.success) return null;
  return parsed.data.errors.map(({ index, code, message }) => ({
    index,
    code,
    message,
  }));
}
