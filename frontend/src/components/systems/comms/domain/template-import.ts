import { templateImportSchema } from "../contract/schemas";
import type { TemplateImport } from "../contract/types";

function invalidImport(): never {
  throw new Error("Template JSON is invalid or contains unsupported fields");
}

/** Raw input and canonical object have independent UTF-8 bounds. */
export function parseTemplateImport(text: string): TemplateImport {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).byteLength > 65_536
  )
    return invalidImport();
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return invalidImport();
  }
  const parsed = templateImportSchema.safeParse(input);
  if (!parsed.success) return invalidImport();
  return parsed.data;
}
