import type { RequestOptions } from "../contract/types";
import type { MemoryClientBinding } from "./availability";
import type {
  createProtectedToolResources,
  ProtectedToolOperations,
} from "./protected-tools";

/** One deferred resource owner, shared across browser admission bindings. */
export function createLazyProtectedTools(
  input: Parameters<typeof createProtectedToolResources>[0],
) {
  let loaded:
    | {
        module: typeof import("./protected-tools");
        resources: ReturnType<typeof createProtectedToolResources>;
      }
    | undefined;
  let retired = false;
  return {
    dispose() {
      retired = true;
      loaded?.resources.dispose();
    },
    bind(binding: MemoryClientBinding): ProtectedToolOperations {
      async function invoke<T>(
        options: RequestOptions | undefined,
        call: (operations: ProtectedToolOperations) => Promise<T>,
      ): Promise<T> {
        const started = input.clock();
        if (!loaded) {
          let familyModule!: typeof import("./protected-tools");
          // The store's existing session fence owns expiry/cancellation while
          // import is pending; restoring a token cannot revive this invocation.
          await binding.handle.command({
            signal: options?.signal,
            prepare: async () => {
              familyModule = await import("./protected-tools");
            },
            authorize() {},
            apply() {
              return { kind: "unchanged", value: null, version_keys: [] };
            },
          });
          binding.handle.read(() => undefined);
          if (retired)
            throw Object.assign(new Error("Cancelled"), { kind: "cancelled" });
          loaded ??= {
            module: familyModule,
            resources: familyModule.createProtectedToolResources(input),
          };
        }
        return call(
          loaded.module.createProtectedToolOperations(
            binding,
            loaded.resources,
            started,
          ),
        );
      }
      return {
        getRetention: (scope, options) =>
          invoke(options, (ops) => ops.getRetention(scope, options)),
        previewRetention: (request, options) =>
          invoke(options, (ops) => ops.previewRetention(request, options)),
        updateRetention: (request, options) =>
          invoke(options, (ops) => ops.updateRetention(request, options)),
        previewPurge: (id, options) =>
          invoke(options, (ops) => ops.previewPurge(id, options)),
        purgeConversation: (id, request, options) =>
          invoke(options, (ops) => ops.purgeConversation(id, request, options)),
        listTemplates: (request, options) =>
          invoke(options, (ops) => ops.listTemplates(request, options)),
        getTemplate: (id, options) =>
          invoke(options, (ops) => ops.getTemplate(id, options)),
        createTemplate: (request, options) =>
          invoke(options, (ops) => ops.createTemplate(request, options)),
        saveTemplate: (id, request, options) =>
          invoke(options, (ops) => ops.saveTemplate(id, request, options)),
        previewTemplateApply: (id, request, options) =>
          invoke(options, (ops) =>
            ops.previewTemplateApply(id, request, options),
          ),
        applyTemplate: (id, request, options) =>
          invoke(options, (ops) => ops.applyTemplate(id, request, options)),
        listConfigurationHistory: (scope, request, options) =>
          invoke(options, (ops) =>
            ops.listConfigurationHistory(scope, request, options),
          ),
        getConfigurationHistory: (scope, id, options) =>
          invoke(options, (ops) =>
            ops.getConfigurationHistory(scope, id, options),
          ),
        previewConfigurationRestore: (scope, id, options) =>
          invoke(options, (ops) =>
            ops.previewConfigurationRestore(scope, id, options),
          ),
        restoreConfiguration: (scope, request, options) =>
          invoke(options, (ops) =>
            ops.restoreConfiguration(scope, request, options),
          ),
        listExports: (request, options) =>
          invoke(options, (ops) => ops.listExports(request, options)),
        getExport: (id, options) =>
          invoke(options, (ops) => ops.getExport(id, options)),
        startExport: (request, options) =>
          invoke(options, (ops) => ops.startExport(request, options)),
        downloadExport: (id, options) =>
          invoke(options, (ops) => ops.downloadExport(id, options)),
      };
    },
  };
}
