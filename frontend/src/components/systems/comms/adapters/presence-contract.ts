import { z } from "zod";
import {
  commsContextSchema,
  markReadRequestSchema,
  presenceRequestSchema,
} from "../contract/schemas";

// S20 B8 HTTP-only contract; the frozen Phase-A CommsClient remains void.
// POST /comms/presence returns 200/no-store. Missing baselines are unknown, and
// changed heads may be lower or previously unknown. Preserve truncated for S26's
// complete-bootstrap recovery; these schemas do not decide visibility or mute policy.
// Observed heads are not proof of fetched history; this transport advances no recovery position.
const sequenceSchema = z.strictObject({
  conversation_id: z.uuid(),
  high_water_seq: markReadRequestSchema.shape.last_read_seq,
});
export const heartbeatPresenceRequestSchema = presenceRequestSchema.extend({
  known_sequences: z
    .array(sequenceSchema)
    .max(100)
    .refine(
      (values) =>
        new Set(values.map((value) => value.conversation_id.toLowerCase()))
          .size === values.length,
      "Observed conversation IDs must be distinct",
    )
    .default([]),
});
export const heartbeatPresenceResponseSchema = commsContextSchema
  .extend({
    changed: z
      .array(sequenceSchema)
      .max(100)
      .refine(
        (values) =>
          values.every(
            (value, index) =>
              index === 0 ||
              values[index - 1].conversation_id.toLowerCase() <
                value.conversation_id.toLowerCase(),
          ),
        "Changed conversation IDs must be unique and UUID-ascending",
      ),
    truncated: z.boolean(),
  })
  .refine(
    (value) => value.changed.length > 0 || !value.truncated,
    "An empty result is not truncated",
  );

export function heartbeatPresenceResponseSchemaFor(
  context: z.output<typeof commsContextSchema>,
) {
  const bound = commsContextSchema.parse(context);
  return heartbeatPresenceResponseSchema.refine(
    (value) => value.org_id === bound.org_id && value.user_id === bound.user_id,
    "Heartbeat must match the bound organization and actor",
  );
}
export type HttpHeartbeatRequest = z.input<
  typeof heartbeatPresenceRequestSchema
>;
export type HttpHeartbeatResponse = z.output<
  typeof heartbeatPresenceResponseSchema
>;
