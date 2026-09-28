import {
  SANDBOX_DOCUMENT_LIMITS,
  type SandboxDocumentV4,
} from "./document-types";
import { parseSandboxDocumentValue } from "./document-parser";

export function exportSandboxDocument(document: SandboxDocumentV4): string {
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
