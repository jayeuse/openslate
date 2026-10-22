import { z } from "zod";
import { ApiContractError, apiFetchWithMetadata } from "@/lib/api";
import { commsContextSchema } from "../contract/schemas";
import type { CommsContext, RequestOptions } from "../contract/types";
import { requestOptions } from "./structure-contract";

export const directCandidateRequestSchema = z.strictObject({
  q: z.string().trim().min(1).max(100),
  limit: z.number().int().min(1).max(20).default(20),
});
const responseSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      user_id: z.uuid(),
      display_name: z.string(),
      avatar_url: z.string().nullable(),
    }),
  ),
});
export type HttpDirectCandidateRequest = z.input<
  typeof directCandidateRequestSchema
>;
export type HttpDirectCandidates = z.output<typeof responseSchema>;

/** D36 discovery is server-owned; the returned bounded set is not a complete Page. */
export async function listDirectCandidates(
  context: CommsContext,
  input: HttpDirectCandidateRequest,
  options: RequestOptions = {},
): Promise<HttpDirectCandidates> {
  const bound = commsContextSchema.parse(context);
  const request = directCandidateRequestSchema.parse(input);
  const query = new URLSearchParams({
    q: request.q,
    limit: String(request.limit),
  });
  const result = await apiFetchWithMetadata(
    `/comms/direct-candidates?${query}`,
    responseSchema.refine(
      ({ items }) =>
        items.length <= request.limit &&
        items.every(
          (row) => row.user_id.toLowerCase() !== bound.user_id.toLowerCase(),
        ) &&
        new Set(items.map((row) => row.user_id.toLowerCase())).size ===
          items.length,
    ),
    { ...requestOptions(bound, options), method: "GET" },
  );
  if (
    result.response.status !== 200 ||
    !result.response.headers.get("Cache-Control")?.includes("no-store")
  )
    throw new ApiContractError();
  return result.data;
}
