"use client";
import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { z } from "zod";
import {
  useVerifiedWorkspaceOrganizationId,
  useVerifiedWorkspaceUserId,
} from "../../shared/runtime/workspace-identity";
import { ownedCommsDraftTextId, useCommsDraftText } from "./draft-text";

/** Small composer fields reuse the owned draft journal, never the sample world. */
export function useCommsDraftValue<T>(
  key: string,
  schema: z.ZodType<T>,
  initial: T,
) {
  const user = useVerifiedWorkspaceUserId(),
    org = useVerifiedWorkspaceOrganizationId();
  const [raw, setRaw, controls] = useCommsDraftText(
    ownedCommsDraftTextId(user, `live:draft:${key}`, org),
    "",
  );
  const decode = useCallback(
    (value: string): T => {
      try {
        const parsed = schema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : initial;
      } catch {
        return initial;
      }
    },
    [schema, initial],
  );
  const value = useMemo(() => decode(raw), [raw, decode]);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (action) =>
      setRaw((previous) =>
        JSON.stringify(
          schema.parse(
            typeof action === "function"
              ? (action as (value: T) => T)(decode(previous))
              : action,
          ),
        ),
      ),
    [decode, schema, setRaw],
  );
  return [value, setValue, controls] as const;
}
