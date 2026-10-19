import { z } from "zod";
import { ApiContractError, type ApiFetchMetadata } from "@/lib/api";
import { pageSchema, preconditionSchema } from "../contract/schemas";
import type * as C from "../contract/types";

// Structure-family boundary checks only; HTTP requests remain in structure-api.
export function requestOptions(
  context: C.CommsContext,
  options: C.RequestOptions,
) {
  return {
    headers: { "X-Org": context.org_id },
    cache: "no-store" as const,
    signal: options.signal,
  };
}

export function conditionalOptions(
  context: C.CommsContext,
  options: C.ConditionalOptions,
) {
  const { if_match } = preconditionSchema.parse({
    if_match: options?.if_match,
  });
  const init = requestOptions(context, options);
  return { ...init, headers: { ...init.headers, "If-Match": if_match } };
}

export function inContext(context: C.CommsContext, id?: string) {
  return (value: { org_id: string; id: string }) =>
    value.org_id === context.org_id && (id === undefined || value.id === id);
}

export function structurePageSchema<Item extends z.ZodType>(
  item: Item,
  request: { limit: number; offset: number },
) {
  return pageSchema(item).refine(
    ({ items, pagination: p }) =>
      p.limit === request.limit &&
      p.offset === request.offset &&
      p.count === items.length &&
      p.count <= p.limit &&
      (p.count === 0 || p.offset + p.count <= p.total) &&
      p.has_more === p.offset + p.count < p.total,
  );
}

export function responseData<Schema extends z.ZodType>(
  result: ApiFetchMetadata<Schema>,
  status = 200,
): z.output<Schema> {
  if (result.response.status !== status) throw new ApiContractError();
  return result.data;
}

export function versioned<Schema extends z.ZodType<{ id: string }>>(
  result: ApiFetchMetadata<Schema>,
  statuses: readonly number[] = [200],
  collection?: string,
): C.Versioned<z.output<Schema>> {
  if (
    !statuses.includes(result.response.status) ||
    !preconditionSchema.safeParse({ if_match: result.etag }).success ||
    (result.response.status === 201 &&
      result.response.headers.get("Location") !==
        `/api${collection}/${result.data.id}`)
  ) {
    throw new ApiContractError();
  }
  // Validation above requires a strong nonempty ETag, not a generated fallback.
  if (result.etag === null) throw new ApiContractError();
  return { data: result.data, etag: result.etag };
}
