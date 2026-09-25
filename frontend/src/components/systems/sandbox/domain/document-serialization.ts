import {
  SANDBOX_DOCUMENT_LIMITS,
  type SandboxDocumentV2,
} from "./document-types";
import { parseSandboxDocumentValue } from "./document-parser";

export function exportSandboxDocument(document: SandboxDocumentV2): string {
  const candidate = JSON.stringify(document);
  if (
    new TextEncoder().encode(candidate).byteLength >
    SANDBOX_DOCUMENT_LIMITS.fileBytes
  )
    throw new Error("Sandbox document exceeds the 5 MiB limit");
  const parsed = parseSandboxDocumentValue(JSON.parse(candidate) as unknown);
  const canonical = JSON.stringify(parsed);
  if (
    new TextEncoder().encode(canonical).byteLength >
    SANDBOX_DOCUMENT_LIMITS.fileBytes
  )
    throw new Error("Sandbox document exceeds the 5 MiB limit");
  return canonical;
}
