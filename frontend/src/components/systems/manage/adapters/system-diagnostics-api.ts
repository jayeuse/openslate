import {
  ApiError,
  apiContractError,
  apiRequest,
  keepRequestId,
} from "@/lib/api";

export type DiagnosticsScope = "installation" | "organization";
export type DiagnosticsFile = { blob: Blob; filename: string };

// The server names the file with the UTC time of the download (API contract
// "Diagnostics downloads", D19.2).
const FILE_NAMES: Readonly<Record<DiagnosticsScope, RegExp>> = {
  installation:
    /^attachment; filename="(slateops-diagnostics-installation-\d{8}-\d{4}Z\.json)"$/,
  organization:
    /^attachment; filename="(slateops-diagnostics-organization-\d{8}-\d{4}Z\.json)"$/,
};

/** The installation owner's file (S6-C2). */
export async function downloadInstallationDiagnostics(
  signal?: AbortSignal,
): Promise<DiagnosticsFile> {
  const response = await apiRequest("/system/diagnostics/installation", {
    cache: "no-store",
    signal,
  });
  return diagnosticsFile(response, "installation");
}

/** An organization admin's file for the bound organization (S6-C3). */
export async function downloadOrganizationDiagnostics(
  signal?: AbortSignal,
): Promise<DiagnosticsFile> {
  const response = await apiRequest("/system/diagnostics/organization", {
    cache: "no-store",
    signal,
  });
  return diagnosticsFile(response, "organization");
}

/**
 * The support file of System health block 6. A fetch with the session, so a
 * failure keeps its status and reference for the page (D19.4); the caller
 * saves the bytes under the server's name.
 */
async function diagnosticsFile(
  response: Response,
  scope: DiagnosticsScope,
): Promise<DiagnosticsFile> {
  if (!response.ok) {
    if (response.body) void response.body.cancel().catch(() => undefined);
    throw keepRequestId(
      new ApiError(response.status, "Support file could not be prepared."),
      response,
    );
  }
  const filename = response.headers
    .get("Content-Disposition")
    ?.match(FILE_NAMES[scope])?.[1];
  const type = response.headers
    .get("Content-Type")
    ?.replaceAll(" ", "")
    .toLowerCase();
  if (
    response.status !== 200 ||
    !filename ||
    (type !== "application/json" &&
      type !== "application/json;charset=utf-8") ||
    !response.headers
      .get("Cache-Control")
      ?.toLowerCase()
      .split(",")
      .some((part) => part.trim() === "no-store")
  )
    throw apiContractError(response);
  const bytes = await response.arrayBuffer();
  return { blob: new Blob([bytes], { type: "application/json" }), filename };
}
