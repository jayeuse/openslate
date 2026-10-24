import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";

// Only the parts Audit reads. `GET /fields/{id}` admits anyone who can read
// the field's module (`sandbox/fields/router.py`), department managers too,
// and also returns a deleted field, whose old values still need a name.
// A select field's `config.options` maps option ids to labels, so a stored
// option id reads as its label (Phase 8).
const optionSchema = z.object({ id: z.string(), label: z.string() });
const auditFieldSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  type: z.string().optional(),
  config: z
    .object({ options: z.array(optionSchema).optional() })
    .loose()
    .optional(),
  is_deleted: z.boolean(),
});

/** What Audit needs of a record field: its name, type and option labels. */
export type AuditField = {
  name: string;
  type: string;
  options: ReadonlyMap<string, string>;
};

/**
 * A record field that an audit row keys by id (MD16): its name, type and
 * select option labels, or null when the viewer cannot read it (403) or it
 * is gone (404): the row then keeps the short id. This read never reports
 * to an access latch; a refused field leaves the rest of Audit as it is.
 */
export async function getAuditField(
  fieldId: string,
  signal?: AbortSignal,
): Promise<AuditField | null> {
  try {
    const field = await apiFetch(
      `/fields/${encodeURIComponent(fieldId)}`,
      auditFieldSchema.refine((item) => item.id === fieldId),
      { signal },
    );
    return {
      name: field.name,
      type: field.type ?? "",
      options: new Map(
        (field.config?.options ?? []).map((option) => [
          option.id,
          option.label,
        ]),
      ),
    };
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 403 || error.status === 404)
    )
      return null;
    throw error;
  }
}
