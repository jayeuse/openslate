import { z } from "zod";
import {
  FILTER_OPERATORS,
  OPENVIEW_MODULE_IDS,
  getModuleDefinition,
  type OpenViewWidget,
} from "../../openview/domain/model";

export type BoardConfiguration = {
  name: string;
  description: string;
  department: string;
  defaultSection: "overview" | "calendar" | "announcements";
  widgets: Omit<OpenViewWidget, "id" | "audience">[];
};
export type ConfigurationResult =
  | { ok: true; configuration: BoardConfiguration }
  | { ok: false; error: string };
const widgetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(["summary", "workload", "records", "chart"]),
    moduleId: z.enum(OPENVIEW_MODULE_IDS),
    size: z.enum(["half", "full"]),
    pinned: z.boolean(),
    refresh: z.enum(["manual", "one-minute", "five-minutes"]),
    fields: z.array(z.string().max(80)).min(1).max(24),
    filters: z
      .object({
        logic: z.enum(["and", "or"]),
        clauses: z
          .array(
            z
              .object({
                field: z.string().max(80),
                operator: z.enum(FILTER_OPERATORS),
                value: z.string().max(300),
              })
              .strict(),
          )
          .max(8),
      })
      .strict(),
    metric: z.string().max(80),
    visualization: z.enum(["bar", "line", "pie"]),
  })
  .strict()
  .superRefine((widget, context) => {
    const fields = getModuleDefinition(widget.moduleId).fields;
    if (
      widget.fields.some((id) => !fields.some((field) => field.id === id)) ||
      widget.filters.clauses.some(
        (clause) => !fields.some((field) => field.id === clause.field),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "A widget references fields that are unavailable in its data source.",
      });
    if (
      widget.metric !== "count" &&
      !fields.some(
        (field) => field.id === widget.metric && field.type === "number",
      )
    )
      context.addIssue({
        code: "custom",
        message: "Choose a supported numeric field or record count.",
      });
  });
const configurationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(240),
    department: z.string().min(1).max(80),
    defaultSection: z.enum(["overview", "calendar", "announcements"]),
    widgets: z.array(widgetSchema).max(12),
  })
  .strict();
const bundleSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("openslate-board"),
    configuration: configurationSchema,
  })
  .strict();

export function parseBoardConfiguration(text: string): ConfigurationResult {
  if (new TextEncoder().encode(text).byteLength > 1024 * 1024)
    return {
      ok: false,
      error: "Choose a board configuration smaller than 1 MiB.",
    };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error:
        "This file is not valid JSON. Choose an exported board configuration.",
    };
  }
  const result = bundleSchema.safeParse(raw);
  if (!result.success)
    return {
      ok: false,
      error:
        "This configuration contains unsupported settings or data references. Export a fresh configuration from Boards.",
    };
  return { ok: true, configuration: result.data.configuration };
}

export function getBoardConfiguration(
  board: Omit<BoardConfiguration, "widgets"> & {
    widgets: readonly OpenViewWidget[];
  },
): BoardConfiguration {
  return {
    name: board.name,
    description: board.description,
    department: board.department,
    defaultSection: board.defaultSection,
    widgets: board.widgets.map((widget) => ({
      name: widget.name,
      type: widget.type,
      moduleId: widget.moduleId,
      size: widget.size,
      pinned: widget.pinned,
      refresh: widget.refresh,
      fields: [...widget.fields],
      filters: structuredClone(widget.filters),
      metric: widget.metric,
      visualization: widget.visualization,
    })),
  };
}

export function exportBoardConfiguration(
  board: Parameters<typeof getBoardConfiguration>[0],
): string {
  return JSON.stringify(
    {
      version: 1,
      kind: "openslate-board",
      configuration: getBoardConfiguration(board),
    },
    null,
    2,
  );
}
