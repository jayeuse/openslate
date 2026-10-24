import { z } from "zod";

import { ApiError, apiFetch } from "@/lib/api";

// Only the parts Audit reads. `GET /fields/{id}` admits anyone who can read
// the field's module (`sandbox/fields/router.py`), department managers too,
// and also returns a deleted field, whose old values still need a name.
const auditFieldSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  is_deleted: z.boolean(),
});

/**
 * The name of a record field that an audit row keys by id (MD16), or null
 * when the viewer cannot read it (403) or it is gone (404): the row then
 * keeps the short id. This read never reports to an access latch; a refused
 * field leaves the rest of Audit as it is.
 */
export async function getAuditFieldName(
  fieldId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const field = await apiFetch(
      `/fields/${encodeURIComponent(fieldId)}`,
      auditFieldSchema.refine((item) => item.id === fieldId),
      { signal },
    );
    return field.name;
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 403 || error.status === 404)
    )
      return null;
    throw error;
  }
}
