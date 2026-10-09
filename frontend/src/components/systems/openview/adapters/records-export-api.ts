import { z } from "zod";
import { ApiContractError, ApiError, apiRequest } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import { trackOpenViewRead } from "./openview-access";
import type { OpenViewQueryDefinition } from "./views-api";
import { serializeOpenViewQueryDefinition } from "./views-serialization";

type ExportSource = {
  moduleId: string;
  viewId: string | null;
  definition: OpenViewQueryDefinition;
  includeRecordId: boolean;
};
export type RecordsExportOptions = ExportSource &
  (
    | { format: "csv" }
    | {
        format: "xlsx";
        title: string | null;
        includeDetails: boolean;
        accent: "theme" | "gray" | "none";
        banded: boolean;
        totals: boolean;
      }
  );

const errorCodeSchema = z.object({
  detail: z.union([z.string(), z.object({ code: z.string() })]),
});

/** Private, complete query output. The whole binary read owns a refusal outcome. */
export function exportOpenViewRecords(
  options: RecordsExportOptions,
  signal: AbortSignal,
): Promise<{ blob: Blob; filename: string }> {
  return trackOpenViewRead(async () => {
    const body = {
      module_id: z.uuid().parse(options.moduleId),
      view_id: z.uuid().nullable().parse(options.viewId),
      definition: serializeOpenViewQueryDefinition(options.definition),
      format: options.format,
      include_record_id: options.includeRecordId,
      ...(options.format === "xlsx"
        ? {
            title: options.title,
            include_details: options.includeDetails,
            accent: options.accent,
            banded: options.banded,
            totals: options.totals,
          }
        : {}),
    };
    const response = await apiRequest("/records/export", {
      method: "POST",
      signal,
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const parsed = errorCodeSchema.safeParse(
        await response.json().catch(() => null),
      );
      const code =
        parsed.success && typeof parsed.data.detail !== "string"
          ? parsed.data.detail.code
          : undefined;
      if (["mfa_required", "ip_not_allowed"].includes(code ?? ""))
        queueMicrotask(() => {
          if (!signal.aborted) requestSessionRecheck();
        });
      throw new ApiError(
        response.status,
        "Export could not be downloaded.",
        undefined,
        code,
      );
    }
    const type = response.headers.get("Content-Type")?.trim().toLowerCase();
    const expectedType =
      options.format === "csv"
        ? /^text\/csv(?:;\s*charset=utf-8)?$/
        : /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/;
    const attachment = response.headers
      .get("Content-Disposition")
      ?.match(/^attachment; filename="([A-Za-z0-9][A-Za-z0-9_.-]{0,179})"$/);
    const filename = attachment?.[1];
    if (
      response.status !== 200 ||
      !type ||
      !expectedType.test(type) ||
      !filename ||
      filename.includes("..") ||
      !filename.endsWith(`.${options.format}`) ||
      !response.headers
        .get("Cache-Control")
        ?.toLowerCase()
        .split(",")
        .some((part) => part.trim() === "no-store") ||
      response.headers.get("X-Content-Type-Options")?.trim().toLowerCase() !==
        "nosniff"
    )
      throw new ApiContractError();
    const blob = await response.blob();
    if (blob.size > 8 * 1024 * 1024) throw new ApiContractError();
    return { blob, filename };
  });
}
