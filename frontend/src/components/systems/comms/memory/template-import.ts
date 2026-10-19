import { templateImportSchema } from "../contract/schemas";
import type { TemplateImport } from "../contract/types";
import { invalidInput } from "../domain/settings";

/** Raw input and canonical object have independent UTF-8 bounds. */
export function parseTemplateImport(text: string): TemplateImport {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).byteLength > 65_536
  )
    return invalidInput();
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return invalidInput();
  }
  const parsed = templateImportSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}
