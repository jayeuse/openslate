import {
  SANDBOX_DOCUMENT_LIMITS,
  type SandboxDocumentParseResult,
} from "./document-types";
import {
  parseSandboxDocumentValue,
  parseSandboxDocumentForApi,
} from "./document-parser";
import { exportSandboxDocument } from "./document-serialization";

export * from "./document-types";
export { parseSandboxDocumentForApi, exportSandboxDocument };

/**
 * Parses a Sandbox document file. A file in a format before version 3 is
 * refused with the older-format message; old designs are not converted.
 */
export function parseSandboxDocument(text: string): SandboxDocumentParseResult {
  try {
    if (
      new TextEncoder().encode(text).byteLength >
      SANDBOX_DOCUMENT_LIMITS.fileBytes
    )
      throw new Error("Sandbox document exceeds the 5 MiB limit");
    const root = JSON.parse(text) as unknown;
    if (typeof root !== "object" || root === null || Array.isArray(root))
      throw new Error("sandbox document must be an object");
    return { ok: true, document: parseSandboxDocumentValue(root) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Sandbox document is invalid",
    };
  }
}
