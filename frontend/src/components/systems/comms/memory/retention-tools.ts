import type { CommsClient } from "../contract/client";
import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { scopeKey } from "../domain/policy-scope";
import { invalidInput } from "../domain/settings";
import { structurePublications } from "./configuration-mutation";
import { readableConversation } from "./message-projections";
import { stageConversationPurge } from "./message-transitions";
import type { MemoryCommsState } from "./model";
import type { ToolSession } from "./protected-tools";

export type RetentionTools = Pick<
  CommsClient,
  | "getRetention"
  | "previewRetention"
  | "updateRetention"
  | "previewPurge"
  | "purgeConversation"
>;
const workspace = { kind: "workspace" } as const;
const retentionKey = (scope: C.RetentionPolicy["scope"]) =>
  `retention:${scopeKey(scope)}`;
function parseScope(input: C.RetentionPolicy["scope"]) {
  const parsed = S.settingsScopeSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind === "category") return invalidInput();
  return parsed.data;
}
function resolve(
  world: Readonly<MemoryCommsState>,
  policy: C.RetentionPolicy,
): C.RetentionResponse {
  const inherited = world.retention.workspace;
  if (
    !inherited ||
    inherited.scope.kind !== "workspace" ||
    inherited.message_days === null ||
    inherited.file_days === null
  )
    return invalidInput();
  return {
    policy,
    effective: {
      message_days: policy.message_days ?? inherited.message_days,
      file_days: policy.file_days ?? inherited.file_days,
    },
    sources: {
      message_days:
        policy.message_days === null ? "workspace" : policy.scope.kind,
      file_days: policy.file_days === null ? "workspace" : policy.scope.kind,
    },
  };
}
function currentPolicy(
  world: Readonly<MemoryCommsState>,
  scope: C.RetentionPolicy["scope"],
): C.RetentionPolicy {
  return (
    world.retention[scopeKey(scope)] ??
    (scope.kind === "workspace"
      ? { scope, message_days: 0, file_days: 0 }
      : { scope, message_days: null, file_days: null })
  );
}

export function createRetentionTools(session: ToolSession): RetentionTools {
  const { handle } = session.binding;
  function witness(
    world: Readonly<MemoryCommsState>,
    policy: C.RetentionPolicy,
  ) {
    const scope = policy.scope;
    const ids =
      scope.kind === "workspace"
        ? Object.keys(world.conversations).sort()
        : [scope.id];
    const selected = new Set(ids);
    return session.describe({
      authority: session.scopeWitness(world, scope),
      resolution: resolve(world, policy),
      impact: impact(world, policy, session.now()),
      retention:
        scope.kind === "workspace"
          ? world.retention
          : {
              workspace: world.retention.workspace,
              local: world.retention[scopeKey(scope)],
            },
      versions: [
        world.resource_versions[retentionKey(workspace)] ?? 0,
        world.resource_versions[retentionKey(scope)] ?? 0,
      ],
      conversations: ids.map((id) => [
        id,
        world.resource_versions[`conversation:${id}`] ?? 0,
        world.conversations[id],
      ]),
      messages: Object.values(world.messages)
        .filter((m) => selected.has(m.conversation_id))
        .map((m) => [m.id, world.resource_versions[`message:${m.id}`] ?? 0])
        .sort(),
      files: Object.values(world.files)
        .filter((f) => selected.has(f.conversation_id))
        .map((f) => [f.id, world.resource_versions[`file:${f.id}`] ?? 0])
        .sort(),
    });
  }
  function impact(
    world: Readonly<MemoryCommsState>,
    policy: C.RetentionPolicy,
    now: number,
  ) {
    const proposed = {
      ...world,
      retention: { ...world.retention, [scopeKey(policy.scope)]: policy },
    };
    const days = (id: string, kind: "message_days" | "file_days") => {
      if (policy.scope.kind === "channel" && id !== policy.scope.id) return 0;
      const scope =
        world.conversations[id]?.kind === "channel"
          ? { kind: "channel" as const, id }
          : workspace;
      return resolve(proposed, currentPolicy(proposed, scope)).effective[kind];
    };
    const old = (
      id: string,
      created: string,
      kind: "message_days" | "file_days",
    ) => {
      const period = days(id, kind);
      return period > 0 && Date.parse(created) < now - period * 86_400_000;
    };
    return {
      message_count: Object.values(world.messages).filter((m) =>
        old(m.conversation_id, m.created_at, "message_days"),
      ).length,
      file_count: Object.values(world.files).filter((f) =>
        old(f.conversation_id, f.created_at, "file_days"),
      ).length,
    };
  }
  function purgeState(world: Readonly<MemoryCommsState>, id: string) {
    session.admin(world);
    const row = readableConversation(world, handle.context, id);
    if (!row.archived_at) return session.conflict();
    const scope =
      row.kind === "channel" ? { kind: "channel" as const, id } : workspace;
    const messages = Object.values(world.messages).filter(
      (m) => m.conversation_id === id,
    );
    const files = Object.values(world.files).filter(
      (f) => f.conversation_id === id,
    );
    return {
      confirmation_name: row.kind === "direct" ? row.id : row.name || row.id,
      message_count: messages.length,
      file_count: files.length,
      max_seq: world.high_water_seq[id] ?? 0,
      witness: session.describe({
        authority: session.scopeWitness(world, scope),
        conversation: row,
        version: world.resource_versions[`conversation:${id}`] ?? 0,
        messages: messages
          .map((m) => [m.id, world.resource_versions[`message:${m.id}`] ?? 0])
          .sort(),
        files: files
          .map((f) => [f.id, world.resource_versions[`file:${f.id}`] ?? 0])
          .sort(),
        max_seq: world.high_water_seq[id] ?? 0,
      }),
    };
  }
  return {
    async getRetention(input, options) {
      session.active(options);
      const scope = parseScope(input);
      return handle.read((world) => {
        session.admin(world, scope);
        return {
          data: resolve(world, currentPolicy(world, scope)),
          etag: handle.version(retentionKey(scope)),
        };
      });
    },
    async previewRetention(input, options) {
      const invocation = session.fresh(options);
      const parsed = S.retentionPolicySchema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const policy = parsed.data;
      const initial = handle.read((world) => {
        session.admin(world, policy.scope);
        return witness(world, policy);
      });
      const result = await handle.command({
        signal: session.signal(options),
        conditions: [
          { key: retentionKey(policy.scope), if_match: options?.if_match },
        ],
        prepare: invocation.prepare,
        authorize(world) {
          session.admin(world, policy.scope);
          invocation.assert();
          if (witness(world, policy) !== initial) session.stale();
        },
        apply(world, execution) {
          const value: C.RetentionPreview = {
            ...resolve(world, policy),
            ...impact(world, policy, execution.now),
            preview_digest: session.token(execution),
            expires_at: new Date(invocation.started + 60_000).toISOString(),
          };
          return { kind: "unchanged", value, version_keys: [] };
        },
      });
      handle.read((world) => {
        session.admin(world, policy.scope);
        invocation.assert();
        if (witness(world, policy) !== initial) session.stale();
      });
      session.remember(
        result.value.preview_digest,
        "retention",
        policy,
        initial,
        invocation.started,
      );
      return result.value;
    },
    async updateRetention(input, options) {
      const invocation = session.fresh(options);
      const parsed = S.retentionRequestSchema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const { preview_digest, ...policy } = parsed.data;
      const initial = handle.read((world) => {
        session.admin(world, policy.scope);
        return witness(world, policy);
      });
      const pending = Object.freeze({ accepted: false });
      const accepted = Object.freeze({ accepted: true });
      let receipt: Readonly<{ accepted: boolean }> = pending;
      const reservation = session.reserve(
        preview_digest,
        "retention",
        policy,
        initial,
        {
          get committed() {
            return receipt === accepted;
          },
        },
      );
      const key = retentionKey(policy.scope);
      try {
        const result = await handle.command({
          signal: session.signal(options),
          conditions: [{ key, if_match: options?.if_match }],
          prepare: invocation.prepare,
          authorize(world) {
            session.admin(world, policy.scope);
            invocation.assert();
            reservation.assert(witness(world, policy));
          },
          apply(draft) {
            draft.retention[scopeKey(policy.scope)] = policy;
            const keys =
              policy.scope.kind === "workspace"
                ? [
                    key,
                    ...Object.values(draft.conversations)
                      .filter((c) => c.kind === "channel")
                      .map((c) => retentionKey({ kind: "channel", id: c.id })),
                  ]
                : [key];
            return {
              kind: "commit",
              value: resolve(draft, policy),
              version_keys: keys,
              publications: structurePublications(draft),
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
    async previewPurge(id, options) {
      session.active(options);
      const started = session.started();
      const initial = handle.read((world) => purgeState(world, id));
      const result = await handle.command({
        signal: session.signal(options),
        prepare: () => session.digest(initial.witness),
        authorize(world) {
          if (purgeState(world, id).witness !== initial.witness)
            session.stale();
        },
        apply(_world, execution, impact_digest) {
          const value: C.PurgePreview = {
            org_id: handle.context.org_id,
            conversation_id: id,
            message_count: initial.message_count,
            file_count: initial.file_count,
            max_seq: initial.max_seq,
            confirmation_name: initial.confirmation_name,
            impact_digest,
            token: session.token(execution),
            expires_at: new Date(started + 60_000).toISOString(),
            last_successful_backup_at: null,
          };
          return { kind: "unchanged", value, version_keys: [] };
        },
      });
      session.active(options);
      handle.read((world) => {
        if (purgeState(world, id).witness !== initial.witness) session.stale();
      });
      session.remember(
        result.value.token,
        "purge",
        { conversation_id: id },
        initial.witness,
        started,
      );
      return result.value;
    },
    async purgeConversation(id, input, options) {
      const invocation = session.fresh({
        ...options,
        password: input?.password,
      });
      const parsed = S.purgeRequestSchema.safeParse(input);
      if (!parsed.success) return invalidInput();
      const request = parsed.data;
      const initial = handle.read((world) => purgeState(world, id));
      const filePurge = session.files.preparePurge(session.store);
      const reservation = session.reserve(
        request.token,
        "purge",
        { conversation_id: id },
        initial.witness,
        filePurge,
      );
      try {
        if (request.confirmation_name !== initial.confirmation_name)
          return invalidInput();
        const result = await handle.command({
          signal: AbortSignal.any([session.signal(options), filePurge.signal]),
          prepare: invocation.prepare,
          authorize(world) {
            const current = purgeState(world, id);
            invocation.assert();
            reservation.assert(current.witness);
            if (request.confirmation_name !== current.confirmation_name)
              return invalidInput();
          },
          apply(draft, execution) {
            const staged = stageConversationPurge(draft, execution, id);
            filePurge.stage(staged.released_file_ids);
            return {
              kind: "commit",
              value: staged.result,
              version_keys: staged.version_keys,
              publications: staged.publications,
            };
          },
          finalize: filePurge.finalize,
        });
        return result.value;
      } finally {
        reservation.release();
      }
    },
  };
}
