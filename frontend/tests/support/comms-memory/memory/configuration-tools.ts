import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import { notFound } from "../domain/access";
import { scopeKey } from "../domain/policy-scope";
import { invalidInput, updateSettings } from "../domain/settings";
import {
  configurationKey,
  configurationSnapshot,
  stageConfigurationChange,
  structurePublications,
} from "./configuration-mutation";
import { readableConversation } from "./message-projections";
import type { MemoryCommsState } from "./model";
import type { ToolSession } from "./protected-tools";
import { invalidMemoryState } from "./snapshot";
import type { MemoryExecution } from "./store-types";

export type ConfigurationTools = Pick<
  CommsClient,
  | "listTemplates"
  | "getTemplate"
  | "createTemplate"
  | "saveTemplate"
  | "previewTemplateApply"
  | "applyTemplate"
  | "listConfigurationHistory"
  | "getConfigurationHistory"
  | "previewConfigurationRestore"
  | "restoreConfiguration"
>;
const workspace = { kind: "workspace" } as const;
const templateKey = (id: string) => `template:${id}`;
function parseScope(input: C.SettingsScope) {
  const parsed = S.settingsScopeSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

export function createConfigurationTools(
  session: ToolSession,
): ConfigurationTools {
  const { handle } = session.binding;
  function template(world: Readonly<MemoryCommsState>, id: string) {
    session.admin(world);
    const row = world.templates[id];
    if (!row || row.org_id !== handle.context.org_id) return notFound();
    return row;
  }
  function validateTemplate(
    world: Readonly<MemoryCommsState>,
    input: C.TemplateImport,
  ) {
    // Reuse ordinary write admission for references/pairs, without writing a scope.
    if (Object.keys(input.settings).length)
      updateSettings(world, workspace, input.settings);
    for (const grant of input.capabilities?.group_grants ?? [])
      if (world.groups[grant.group_id]?.org_id !== world.org_id)
        return invalidInput();
  }
  function history(
    world: Readonly<MemoryCommsState>,
    scope: C.SettingsScope,
    id: string,
  ) {
    session.admin(world, scope);
    const row = world.history[id];
    if (
      !row ||
      row.org_id !== handle.context.org_id ||
      scopeKey(row.scope) !== scopeKey(scope)
    )
      return notFound();
    return row;
  }
  function restoreState(
    world: Readonly<MemoryCommsState>,
    scope: C.SettingsScope,
    id: string,
  ) {
    const row = history(world, scope, id);
    const before = configurationSnapshot(world, scope);
    return {
      before,
      after: row.before,
      proposal: { scope, history_id: id, after: row.before },
      witness: session.describe({
        scope: session.scopeWitness(world, scope),
        history: row,
        before,
      }),
    };
  }
  function templatePlan(
    world: Readonly<MemoryCommsState>,
    id: string,
    request: C.TemplateApplyRequest,
  ) {
    const source = template(world, id);
    validateTemplate(world, source);
    const targets = request.conversation_ids.map((conversationId) => {
      const row = readableConversation(world, handle.context, conversationId);
      if (row.kind !== "channel") return invalidInput();
      const scope = { kind: "channel", id: conversationId } as const;
      const before = configurationSnapshot(world, scope);
      const next = structuredClone(before);
      const skipped = request.keys.filter((key) =>
        world.setting_locks.includes(key),
      );
      const applied = request.keys.filter(
        (key) => !skipped.includes(key) && Object.hasOwn(source.settings, key),
      );
      for (const key of applied)
        Object.assign(next.settings, {
          [key]: structuredClone(source.settings[key]),
        });
      const capabilities = source.capabilities;
      const selectedCapabilities = request.capability_keys ?? [];
      const skippedCapabilities = selectedCapabilities.filter((key) =>
        world.capability_locks.includes(key),
      );
      const appliedCapabilities = capabilities
        ? selectedCapabilities.filter(
            (key) => !skippedCapabilities.includes(key),
          )
        : [];
      if (capabilities) {
        next.capabilities.group_grants = [
          ...next.capabilities.group_grants.filter(
            (grant) =>
              !appliedCapabilities.some((key) => key === grant.capability),
          ),
          ...capabilities.group_grants.filter((grant) =>
            appliedCapabilities.some((key) => key === grant.capability),
          ),
        ];
        for (const key of appliedCapabilities) {
          const everyone = S.everyoneCapabilitySchema.safeParse(key);
          if (!everyone.success) continue;
          delete next.capabilities.everyone[everyone.data];
          const value = capabilities.everyone[everyone.data];
          if (value !== undefined)
            next.capabilities.everyone[everyone.data] = value;
        }
      }
      return {
        scope,
        next,
        witness: session.scopeWitness(world, scope),
        preview: {
          conversation_id: conversationId,
          before: before.settings,
          after: next.settings,
          skipped_locked_keys: skipped,
          ...(capabilities
            ? {
                capabilities: {
                  before: {
                    everyone: before.capabilities.everyone,
                    group_grants: before.capabilities.group_grants,
                  },
                  after: {
                    everyone: next.capabilities.everyone,
                    group_grants: next.capabilities.group_grants,
                  },
                  skipped_locked: skippedCapabilities,
                },
              }
            : {}),
        },
        result: {
          conversation_id: conversationId,
          applied_keys: applied,
          skipped_locked_keys: skipped,
          ...(capabilities
            ? {
                applied_capabilities: appliedCapabilities,
                skipped_locked_capabilities: skippedCapabilities,
              }
            : {}),
        },
      };
    });
    const preview = S.templateApplyPreviewSchema.safeParse({
      items: targets.map((target) => target.preview),
    });
    const result = S.templateApplyResultSchema.safeParse({
      items: targets.map((target) => target.result),
    });
    if (!preview.success || !result.success) return invalidMemoryState();
    return {
      targets,
      preview: preview.data,
      result: result.data,
      witness: session.describe({
        request,
        source,
        version: handle.version(templateKey(id)),
        targets: targets.map((target) => ({
          scope: target.scope,
          witness: target.witness,
          next: target.next,
        })),
      }),
    };
  }
  function validatePlan(
    world: Readonly<MemoryCommsState>,
    execution: MemoryExecution,
    plan: ReturnType<typeof templatePlan>,
  ) {
    const detached = structuredClone(world);
    for (const target of plan.targets)
      stageConfigurationChange(detached, execution, target.scope, target.next);
  }
  async function save(
    id: string | undefined,
    input: C.TemplateImport,
    options?: C.ConditionalOptions | C.RequestOptions,
  ) {
    session.active(options);
    const parsed = S.templateImportSchema.safeParse(input);
    if (!parsed.success) return invalidInput();
    const result = await handle.command({
      signal: session.signal(options),
      conditions: id
        ? [
            {
              key: templateKey(id),
              if_match:
                options && "if_match" in options ? options.if_match : undefined,
            },
          ]
        : [],
      authorize(world) {
        session.admin(world);
        if (id) template(world, id);
        validateTemplate(world, parsed.data);
      },
      apply(draft, execution) {
        const key = id ?? execution.uuid();
        if (!id && Object.hasOwn(draft.templates, key))
          return invalidMemoryState();
        const timestamp = new Date(execution.now).toISOString();
        const row: C.Template = {
          ...parsed.data,
          id: key,
          org_id: handle.context.org_id,
          created_at: id ? draft.templates[id].created_at : timestamp,
          updated_at: timestamp,
        };
        draft.templates[key] = row;
        return {
          kind: "commit",
          value: row,
          version_keys: [templateKey(key)],
          publications: structurePublications(draft),
        };
      },
    });
    return {
      data: result.value,
      etag: result.versions[templateKey(result.value.id)],
    };
  }
  return {
    async listTemplates(request, options) {
      session.active(options);
      return handle.read((world) => {
        session.admin(world);
        return session.timePage(
          Object.values(world.templates).filter(
            (row) => row.org_id === handle.context.org_id,
          ),
          request,
        );
      });
    },
    async getTemplate(id, options) {
      session.active(options);
      return handle.read((world) => ({
        data: template(world, id),
        etag: handle.version(templateKey(id)),
      }));
    },
    createTemplate: (request, options) => save(undefined, request, options),
    saveTemplate: save,
    async previewTemplateApply(id, input, options) {
      session.active(options);
      const started = session.started();
      const parsed = S.templateApplyRequestSchema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const initial = handle.read((world) =>
        templatePlan(world, id, parsed.data),
      );
      const result = await handle.command({
        signal: session.signal(options),
        authorize(world) {
          if (templatePlan(world, id, parsed.data).witness !== initial.witness)
            session.stale();
        },
        apply(world, execution) {
          validatePlan(world, execution, initial);
          return {
            kind: "unchanged",
            value: {
              data: initial.preview,
              etag: `"${session.token(execution)}"`,
            },
            version_keys: [],
          };
        },
      });
      session.active(options);
      handle.read((world) => {
        if (templatePlan(world, id, parsed.data).witness !== initial.witness)
          session.stale();
      });
      session.remember(
        result.value.etag,
        "template",
        { id, request: parsed.data },
        initial.witness,
        started,
      );
      return result.value;
    },
    async applyTemplate(id, input, options) {
      session.active(options);
      const parsed = S.templateApplyRequestSchema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const initial = handle.read((world) =>
        templatePlan(world, id, parsed.data),
      );
      const etag = session.precondition(options?.if_match);
      const pending = Object.freeze({ accepted: false });
      const accepted = Object.freeze({ accepted: true });
      let receipt: Readonly<{ accepted: boolean }> = pending;
      const reservation = session.reserve(
        etag,
        "template",
        { id, request: parsed.data },
        initial.witness,
        {
          get committed() {
            return receipt === accepted;
          },
        },
      );
      try {
        const result = await handle.command({
          signal: session.signal(options),
          authorize(world) {
            reservation.assert(templatePlan(world, id, parsed.data).witness);
          },
          apply(draft, execution) {
            validatePlan(draft, execution, initial);
            const keys = new Set<string>();
            for (const target of initial.targets) {
              const changed =
                session.describe(configurationSnapshot(draft, target.scope)) !==
                session.describe(target.next);
              if (!changed) continue;
              const staged = stageConfigurationChange(
                draft,
                execution,
                target.scope,
                target.next,
              );
              for (const key of staged.version_keys) keys.add(key);
            }
            return {
              kind: "commit",
              value: initial.result,
              version_keys: [...keys],
              publications: keys.size ? structurePublications(draft) : [],
            };
          },
          finalize: () => {
            receipt = accepted;
            return undefined;
          },
        });
        return result.value;
      } finally {
        reservation.release();
      }
    },
    async listConfigurationHistory(input, request, options) {
      session.active(options);
      const scope = parseScope(input);
      return handle.read((world) => {
        session.admin(world, scope);
        return session.timePage(
          Object.values(world.history).filter(
            (row) =>
              row.org_id === handle.context.org_id &&
              scopeKey(row.scope) === scopeKey(scope),
          ),
          request,
        );
      });
    },
    async getConfigurationHistory(input, id, options) {
      session.active(options);
      const scope = parseScope(input);
      return handle.read((world) => history(world, scope, id));
    },
    async previewConfigurationRestore(input, id, options) {
      const invocation = session.fresh(options);
      const scope = parseScope(input);
      const initial = handle.read((world) => restoreState(world, scope, id));
      const key = configurationKey(scope);
      const result = await handle.command({
        signal: session.signal(options),
        conditions: [{ key, if_match: options?.if_match }],
        prepare: invocation.prepare,
        authorize(world) {
          const current = restoreState(world, scope, id);
          invocation.assert();
          if (current.witness !== initial.witness) session.stale();
        },
        apply(world, execution) {
          // Validate with the SAME writer on a detached draft; no history is installed.
          stageConfigurationChange(
            structuredClone(world),
            execution,
            scope,
            initial.after,
          );
          const value: C.ConfigurationRestorePreview = {
            org_id: handle.context.org_id,
            history_id: id,
            scope,
            before: initial.before,
            after: initial.after,
            preview_digest: session.token(execution),
            expires_at: new Date(invocation.started + 60_000).toISOString(),
          };
          return { kind: "unchanged", value, version_keys: [key] };
        },
      });
      handle.read((world) => {
        const current = restoreState(world, scope, id);
        invocation.assert();
        if (current.witness !== initial.witness) session.stale();
      });
      session.remember(
        result.value.preview_digest,
        "restore",
        initial.proposal,
        initial.witness,
        invocation.started,
      );
      return { data: result.value, etag: result.versions[key] };
    },
    async restoreConfiguration(input, request, options) {
      const invocation = session.fresh(options);
      const scope = parseScope(input);
      const parsed = S.configurationRestoreRequestSchema.safeParse(request);
      if (!parsed.success) return invalidInput();
      const { history_id, preview_digest } = parsed.data;
      const initial = handle.read((world) =>
        restoreState(world, scope, history_id),
      );
      const pending = Object.freeze({ accepted: false });
      const accepted = Object.freeze({ accepted: true });
      let receipt: Readonly<{ accepted: boolean }> = pending;
      const reservation = session.reserve(
        preview_digest,
        "restore",
        initial.proposal,
        initial.witness,
        {
          get committed() {
            return receipt === accepted;
          },
        },
      );
      const key = configurationKey(scope);
      try {
        const result = await handle.command({
          signal: session.signal(options),
          conditions: [{ key, if_match: options?.if_match }],
          prepare: invocation.prepare,
          authorize(world) {
            const current = restoreState(world, scope, history_id);
            invocation.assert();
            reservation.assert(current.witness);
          },
          apply(draft, execution) {
            const staged = stageConfigurationChange(
              draft,
              execution,
              scope,
              initial.after,
            );
            return {
              kind: "commit",
              value: configurationSnapshot(draft, scope),
              version_keys: staged.version_keys,
              publications: staged.publications,
            };
          },
          finalize: () => {
            receipt = accepted;
            return undefined;
          },
        });
        return { data: result.value, etag: result.versions[key] };
      } finally {
        reservation.release();
      }
    },
  };
}
