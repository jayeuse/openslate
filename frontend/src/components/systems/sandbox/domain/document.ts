import { parseSandboxFile } from "../helpers/file-format";
import {
  SANDBOX_DOCUMENT_LIMITS,
  type SandboxDocumentParseResult,
} from "./document-types";
import {
  parseSandboxDocumentValue,
  parseSandboxDocumentForApi,
} from "./document-parser";
import { exportSandboxDocument } from "./document-serialization";
import { migrateSandboxFileV1 } from "./document-migration";

export * from "./document-types";
export {
  parseSandboxDocumentForApi,
  exportSandboxDocument,
  migrateSandboxFileV1,
};

/** Compatibility facade for strict v1 migration and v2 document parsing. */
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
    if ((root as Record<string, unknown>).schemaVersion === 1) {
      const parsedV1 = parseSandboxFile(
        text,
        SANDBOX_DOCUMENT_LIMITS.fileBytes,
      );
      if (!parsedV1.ok) throw new Error(parsedV1.error);
      return { ok: true, document: migrateSandboxFileV1(parsedV1.file) };
    }
    return { ok: true, document: parseSandboxDocumentValue(root) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Sandbox document is invalid",
    };
  }
}
