import { z } from "zod";
import { ApiContractError, apiFetch } from "@/lib/api";
import {
  assertLifecyclePreviewFor,
  assertLifecycleResultFor,
  lifecycleCloseInputSchema,
  lifecycleClosePreviewSchema,
  lifecyclePurgeInputSchema,
  lifecyclePurgePreviewSchema,
  lifecyclePurgeResultSchema,
  type LifecyclePurgeInput,
} from "@/lib/lifecycle";

const bindingSchema = z
  .strictObject({
    kind: z.enum(["department", "module", "field", "relationship", "trigger"]),
    sandbox_id: z.string().min(1),
    parent_sandbox_id: z.string().min(1).nullable(),
    live_id: z.string().uuid(),
    is_deleted: z.boolean(),
  })
  .refine((binding) =>
    binding.kind === "field"
      ? binding.parent_sandbox_id !== null
      : binding.parent_sandbox_id === null,
  );
const bindingsSchema = z.strictObject({
  document_revision: z.number().int().positive(),
  items: z.array(bindingSchema),
});
export type SandboxBinding = z.output<typeof bindingSchema>;
export type SandboxBindings = z.output<typeof bindingsSchema>;
export type SandboxLifecycleKind =
  "department" | "module" | "field" | "relationship";
export type SandboxLifecycleBinding = SandboxBinding & {
  kind: SandboxLifecycleKind;
};
export type SandboxLifecycleOperation = "close" | "reopen" | "purge";
export type SandboxLifecycleRequest = {
  binding: SandboxLifecycleBinding;
  operation: SandboxLifecycleOperation;
};

export function getSandboxBindings(
  signal?: AbortSignal,
): Promise<SandboxBindings> {
  return apiFetch("/sandbox/bindings", bindingsSchema, {
    cache: "no-store",
    signal,
  });
}

function targetPath(binding: SandboxLifecycleBinding): string {
  const kind = z
    .enum(["department", "module", "field", "relationship"])
    .parse(binding.kind);
  const liveId = z.string().uuid().parse(binding.live_id);
  return kind === "department"
    ? `/departments/${liveId}`
    : kind === "module"
      ? `/modules/${liveId}`
      : `/fields/${liveId}`;
}

export async function previewSandboxLifecycle(
  request: SandboxLifecycleRequest,
) {
  if (request.operation !== "close" && request.operation !== "purge")
    throw new ApiContractError();
  const path =
    request.operation === "close"
      ? `${targetPath(request.binding)}/close/preview`
      : `${targetPath(request.binding)}/purge/preview`;
  const result = await apiFetch(
    path,
    request.operation === "close"
      ? lifecycleClosePreviewSchema
      : lifecyclePurgePreviewSchema,
    {
      method: "POST",
      cache: "no-store",
    },
  );
  assertLifecyclePreviewFor(
    result,
    request.binding.kind === "relationship" ? "field" : request.binding.kind,
    request.binding.live_id,
    request.operation,
  );
  return result;
}

export async function confirmSandboxLifecycle(
  request: SandboxLifecycleRequest,
  input?: LifecyclePurgeInput,
) {
  const payload =
    request.operation === "reopen"
      ? { confirmed: true }
      : (() => {
          const validated = (
            request.operation === "close"
              ? lifecycleCloseInputSchema
              : lifecyclePurgeInputSchema
          ).parse(input);
          return {
            token: validated.token,
            confirmation_name: validated.confirmationName,
            password: validated.password,
          };
        })();
  const path = targetPath(request.binding);
  z.enum(["close", "purge", "reopen"]).parse(request.operation);
  const operation =
    request.operation === "close"
      ? "close"
      : request.operation === "purge"
        ? "purge"
        : "reopen";
  const result = await apiFetch(
    `${path}/${operation}`,
    lifecyclePurgeResultSchema,
    { method: "POST", cache: "no-store", body: JSON.stringify(payload) },
  );
  assertLifecycleResultFor(
    result,
    request.binding.kind === "relationship" ? "field" : request.binding.kind,
    request.binding.live_id,
    request.operation,
  );
  return result;
}
