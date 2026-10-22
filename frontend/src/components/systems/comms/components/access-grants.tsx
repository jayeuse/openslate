"use client";
import { useId, useState, type ReactNode } from "react";
import { User, Users } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchSelect } from "@/components/ui/search-select";
import { Action } from "../../shared/components/ui";
import type * as C from "../contract/types";
import { useCommsClient } from "../state/client-context";
import {
  messageFromCommsError,
  useCommsCommands,
  useCommsRead,
  useCommsRefusals,
} from "../state/runtime";
import { DepartmentList, DepartmentName } from "./channel-scope";
import { LevelBadge } from "./member-level";

const LEVEL_LABELS: Record<C.AccessGrantLevel, string> = {
  read: "Read",
  post: "Read and post",
};
const LEVELS = ["read", "post"] as const;
const subjectKey = (subject: C.AccessGrantSubject, id: string) =>
  `${subject}:${id}`;
function without<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * D45 "Also has access": groups and people outside the department who also
 * read or post. A channel lists its category's grants first, read-only; its
 * own grants save one row at a time. Shown only to people who manage the
 * target: a refused read (403) shows nothing. Category grants are written
 * only by admins and managers of the category's department; others who
 * manage the category see them read-only.
 */
export function AccessGrantsEditor({
  target,
  departmentId,
  categoryName,
}: {
  target: C.AccessGrantTarget;
  /** The department whose roles already give access. */
  departmentId: string;
  /** The channel's current category, which names its inherited grants. */
  categoryName?: string;
}) {
  const key = `access-grants:${target.kind}:${target.id}`;
  const list = useCommsRead(key, (client, signal) =>
    client.listAccessGrants(target, { signal }),
  );
  const refused = useCommsRefusals()?.[key] === true;
  const { run, isPending } = useCommsCommands();
  const { managedDepartmentIds } = useCommsClient();
  const editable =
    target.kind === "channel" ||
    managedDepartmentIds === "all" ||
    managedDepartmentIds.has(departmentId);
  const [levels, setLevels] = useState<Record<string, C.AccessGrantLevel>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [giving, setGiving] = useState(false);
  const headingId = useId();
  if (refused) return null;
  if (!list.data)
    return list.status === "error" ? (
      <div className="flex max-w-prose flex-col gap-2">
        <Alert role="alert" variant="destructive">
          People with extra access could not be loaded.
        </Alert>
        <Action className="self-start" onClick={list.reload}>
          Try again
        </Action>
      </div>
    ) : (
      <p role="status" className="text-muted-foreground text-sm">
        Loading who else has access…
      </p>
    );
  const items = list.data.data.items;
  const inherited = items.filter((item) => item.source !== target.kind);
  const own = items.filter((item) => item.source === target.kind);
  const granted = new Set(
    own.map((item) => subjectKey(item.subject, item.subject_id)),
  );

  async function change(
    grant: Pick<C.AccessGrant, "subject" | "subject_id">,
    level: C.AccessGrantLevel | null,
  ) {
    const id = subjectKey(grant.subject, grant.subject_id);
    setErrors((current) => without(current, id));
    if (level) setLevels((current) => ({ ...current, [id]: level }));
    try {
      await run(
        `access-grant:${target.kind}:${target.id}:${id}`,
        async (client, signal) => {
          // The target's current token, so a change never replays a stale read.
          const current = await client.listAccessGrants(target, { signal });
          const options = { if_match: current.etag, signal };
          if (level)
            await client.setAccessGrant(
              target,
              grant.subject,
              grant.subject_id,
              { level },
              options,
            );
          else
            await client.removeAccessGrant(
              target,
              grant.subject,
              grant.subject_id,
              options,
            );
        },
      );
    } catch (failure) {
      setLevels((current) => without(current, id));
      setErrors((current) => ({
        ...current,
        [id]: messageFromCommsError(
          failure,
          level
            ? "Access could not be changed. Try again."
            : "Access could not be removed. Try again.",
          "Someone changed access first. Check the list, then try again.",
        ),
      }));
    }
  }

  const where =
    target.kind === "channel" ? "this channel" : "channels in this category";
  return (
    <section
      aria-labelledby={headingId}
      className="flex max-w-prose flex-col gap-3 text-sm"
    >
      <div className="flex flex-col gap-1">
        <h4 id={headingId} className="text-sm font-medium">
          Also has access
        </h4>
        {target.kind === "category" && (
          <p className="text-muted-foreground text-sm">
            Applies to every channel in this category.
          </p>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
            Only people with a role in <DepartmentName id={departmentId} /> can
            use {where}.
          </span>
        </p>
      ) : (
        <ul
          aria-label="Groups and people with extra access"
          className="divide-border flex flex-col divide-y rounded-lg border"
        >
          {inherited.map((grant) => (
            <GrantRow
              key={`category:${subjectKey(grant.subject, grant.subject_id)}`}
              grant={grant}
              note={`From category ${categoryName ?? ""}`.trim()}
            />
          ))}
          {own.map((grant) => {
            const id = subjectKey(grant.subject, grant.subject_id);
            if (!editable) return <GrantRow key={id} grant={grant} />;
            const pending = isPending(
              `access-grant:${target.kind}:${target.id}:${id}`,
            );
            // The chosen level shows while it saves and the list refreshes.
            const level =
              levels[id] && (pending || list.refreshing)
                ? levels[id]
                : grant.level;
            return (
              <GrantRow
                key={id}
                grant={grant}
                error={errors[id]}
                pending={pending}
                controls={(describedBy) => (
                  <>
                    <NativeSelect
                      aria-label={`Access for ${grant.display_name}`}
                      aria-describedby={describedBy}
                      value={level}
                      disabled={pending}
                      className="w-full sm:w-40 [&_select]:min-h-11"
                      onChange={(event) =>
                        void change(
                          grant,
                          event.target.value as C.AccessGrantLevel,
                        )
                      }
                    >
                      {LEVELS.map((value) => (
                        <NativeSelectOption key={value} value={value}>
                          {LEVEL_LABELS[value]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 shrink-0 underline-offset-4 hover:underline"
                      aria-label={`Remove access for ${grant.display_name}`}
                      aria-describedby={describedBy}
                      disabled={pending}
                      onClick={() => void change(grant, null)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              />
            );
          })}
        </ul>
      )}
      {!editable ? (
        <p className="text-muted-foreground text-sm">
          <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
            Only an admin or a manager of <DepartmentName id={departmentId} />{" "}
            can change this list.
          </span>
        </p>
      ) : giving ? (
        <GiveAccessPanel
          target={target}
          granted={granted}
          onClose={() => setGiving(false)}
        />
      ) : (
        <Action className="self-start" onClick={() => setGiving(true)}>
          Give access
        </Action>
      )}
    </section>
  );
}

function GrantRow({
  grant,
  note,
  controls,
  pending = false,
  error,
}: {
  grant: C.AccessGrant;
  /** Read-only rows say where they come from instead of offering controls. */
  note?: string;
  /** The row's controls, pointed at the row's error while it shows. */
  controls?: (describedBy: string | undefined) => ReactNode;
  pending?: boolean;
  error?: string;
}) {
  const { groups } = useCommsClient();
  const errorId = useId();
  const Icon = grant.subject === "group" ? Users : User;
  const size =
    grant.subject === "group"
      ? groups.find((group) => group.id === grant.subject_id)?.memberIds.length
      : undefined;
  // A person reads by departments; an older server sends none, so "Person".
  const kind =
    grant.subject === "group" ? (
      size === undefined ? (
        "Group"
      ) : (
        `Group · ${size} ${size === 1 ? "person" : "people"}`
      )
    ) : grant.departments ? (
      <DepartmentList names={grant.departments.map((item) => item.name)} />
    ) : (
      "Person"
    );
  return (
    <li
      aria-busy={pending || undefined}
      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon
          size={16}
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 shrink-0"
        />
        <div className="flex min-w-0 flex-col">
          <bdi className="truncate text-sm font-medium">
            {grant.display_name}
          </bdi>
          <span className="text-muted-foreground text-xs">
            {note ?? kind}
            {pending && " · Saving…"}
          </span>
        </div>
      </div>
      {controls ? (
        <div className="flex items-center gap-1 sm:shrink-0">
          {controls(error ? errorId : undefined)}
        </div>
      ) : (
        <LevelBadge
          level={grant.level}
          label={LEVEL_LABELS[grant.level]}
          className="self-start sm:self-center"
        />
      )}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-destructive text-sm sm:basis-full"
        >
          {error}
        </p>
      )}
    </li>
  );
}

function GiveAccessPanel({
  target,
  granted,
  onClose,
}: {
  target: C.AccessGrantTarget;
  /** Subjects that already have a grant on this target. */
  granted: Set<string>;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<{ value: string; label: string } | null>(
    null,
  );
  const [level, setLevel] = useState<C.AccessGrantLevel>("read");
  const [error, setError] = useState("");
  const { run, isPending } = useCommsCommands();
  const levelId = useId();
  const errorId = useId();
  const q = search.trim();
  const candidates = useCommsRead(
    `access-candidates:${target.kind}:${target.id}:${q}`,
    async (client, signal) =>
      q
        ? client.listAccessCandidates(target, { q, limit: 20 }, { signal })
        : { people: [], groups: [] },
  );
  const pending = isPending(`access-give:${target.kind}:${target.id}`);
  const options = [
    ...(candidates.data?.groups ?? []).map((group) => {
      const value = subjectKey("group", group.id);
      return {
        value,
        label: group.name,
        group: "Groups",
        disabled: granted.has(value),
        description: granted.has(value) ? "Already has access" : undefined,
      };
    }),
    ...(candidates.data?.people ?? []).map((person) => {
      const value = subjectKey("user", person.user_id);
      const departments = person.departments.map((row) => row.name).join(", ");
      return {
        value,
        label: person.display_name,
        group: "People",
        disabled: granted.has(value),
        description:
          [departments, granted.has(value) ? "Already has access" : ""]
            .filter(Boolean)
            .join(" · ") || undefined,
      };
    }),
  ];
  async function give() {
    if (!chosen || pending) return;
    const [subject, id] = chosen.value.split(":") as [
      C.AccessGrantSubject,
      string,
    ];
    setError("");
    try {
      await run(
        `access-give:${target.kind}:${target.id}`,
        async (client, signal) => {
          const current = await client.listAccessGrants(target, { signal });
          await client.setAccessGrant(
            target,
            subject,
            id,
            { level },
            { if_match: current.etag, signal },
          );
        },
      );
      onClose();
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "Access could not be given. Try again.",
          "Someone changed access first. Check the list, then try again.",
        ),
      );
    }
  }
  return (
    <div className="bg-muted flex flex-col gap-3 rounded-lg p-3">
      <SearchSelect
        label="Group or person"
        value={chosen?.value ?? ""}
        selectedOption={chosen ?? undefined}
        options={options}
        search={search}
        onSearchChange={setSearch}
        onValueChange={(value) => {
          const option = options.find((row) => row.value === value);
          if (option && !option.disabled)
            setChosen({ value, label: option.label });
        }}
        placeholder="Choose a group or person"
        searchPlaceholder="Type a name…"
        loading={!!q && candidates.status === "loading" && !candidates.data}
        error={candidates.status === "error" ? candidates.error : undefined}
        onRetry={candidates.reload}
        emptyMessage={
          q ? "No groups or people match." : "Type a name to find them."
        }
        disabled={pending}
      />
      <div className="flex flex-col gap-1">
        <p id={levelId} className="text-sm font-medium">
          Level
        </p>
        <RadioGroup
          aria-labelledby={levelId}
          value={level}
          onValueChange={(value) => setLevel(value as C.AccessGrantLevel)}
          className="flex flex-wrap gap-x-4 gap-y-0"
          disabled={pending}
        >
          {LEVELS.map((value) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
            >
              <RadioGroupItem value={value} />
              {LEVEL_LABELS[value]}
            </label>
          ))}
        </RadioGroup>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Action
          variant="default"
          disabled={!chosen || pending}
          aria-describedby={error ? errorId : undefined}
          onClick={() => void give()}
        >
          {pending ? "Giving access…" : "Give access"}
        </Action>
        <Action variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Action>
      </div>
    </div>
  );
}
