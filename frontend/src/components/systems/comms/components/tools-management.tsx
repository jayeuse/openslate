"use client";
import { useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ChevronDown } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";

import { useCommsConfiguration } from "../state/configuration-state";
import {
  DEFAULT_COMMS_SETTINGS,
  getCommsScope,
  resolveCommsSettings,
  resolveCommsPermission,
  type CommsSettingKey,
  type CommsTemplate,
} from "../domain/configuration";
import { useSampleState } from "../../shared/runtime/sample-state";
import { CATEGORIES, CHANNELS } from "../domain/model";
import { initialPeople, initialRoles } from "../../shared/data/sample-people";
import {
  parseSettingsImport,
  selectedSettings,
  recordScopeChange,
} from "../domain/tools-helpers";
import { ConfigurationFrame } from "./configuration-frame";
import { SettingsFields, SETTINGS_LABELS } from "./settings-fields";
import {
  COMMS_CONFIGURATION_KEY,
  messageFromCommsError,
  readCommsConfiguration,
  stageCommsConfiguration,
  useCommsCommands,
} from "../state/runtime";

type TemplateSaveResult =
  { ok: true; templates: CommsTemplate[] } | { ok: false; error: string };

export function ManagementTools({
  view,
  channelId,
  opener,
  onClose,
}: {
  view: "management" | "templates";
  channelId?: string;
  opener: HTMLElement | null;
  onClose: () => void;
}) {
  const [config] = useCommsConfiguration();
  const { run } = useCommsCommands();
  const [channels] = useSampleState("commsChannels", CHANNELS);
  const [categories] = useSampleState("commsCategories", CATEGORIES);
  const [people] = useSampleState("access-people", initialPeople);
  const [roles] = useSampleState("access-roles", initialRoles);
  const [templates, setTemplates] = useState(config.templates);
  const [active, setActive] = useState(templates[0]?.id ?? "");
  const selected = templates.find((t) => t.id === active);
  const [name, setName] = useState(selected?.name ?? "");
  const [description, setDescription] = useState(selected?.description ?? "");
  const [json, setJson] = useState(
    JSON.stringify(selected?.settings ?? { mode: "normal" }, null, 2),
  );
  const [targets, setTargets] = useState<string[]>(
    channelId ? [channelId] : [],
  );
  const [keys, setKeys] = useState<CommsSettingKey[]>(
    view === "templates"
      ? (Object.keys(selected?.settings ?? {}) as CommsSettingKey[])
      : [],
  );
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [filter, setFilter] = useState("");
  const [invitePerson, setInvitePerson] = useState("");
  const [membershipType, setMembershipType] = useState<"invite" | "request">(
    "invite",
  );
  const [fieldSearch, setFieldSearch] = useState("");
  const [edited, setEdited] = useState(false);
  const viewer = people.find((p) => p.id === "sample-eli");
  const canManage = resolveCommsPermission(
    config,
    { person: viewer },
    "manageWorkspace",
  ).allowed;
  function changeJson(value: string) {
    setJson(value);
    setKeys([]);
    setPreview(false);
    setEdited(true);
  }
  function load(template: CommsTemplate) {
    setActive(template.id);
    setName(template.name);
    setDescription(template.description);
    setJson(JSON.stringify(template.settings, null, 2));
    setKeys(Object.keys(template.settings) as CommsSettingKey[]);
    setPreview(false);
    setError("");
  }
  function validate() {
    try {
      const value = parseSettingsImport(json);
      setError("");
      return value;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid settings.");
      return null;
    }
  }
  const parsed = (() => {
    try {
      return parseSettingsImport(json);
    } catch {
      return {};
    }
  })();
  const fields = (
    Object.keys(DEFAULT_COMMS_SETTINGS) as CommsSettingKey[]
  ).filter(
    (k) =>
      k !== "dmRule" &&
      SETTINGS_LABELS[k].toLowerCase().includes(fieldSearch.toLowerCase()),
  );
  const values = { ...DEFAULT_COMMS_SETTINGS, ...parsed };
  const picked = selectedSettings(values, keys);
  const selectedChannels = channels.filter((c) => targets.includes(c.id));
  async function apply() {
    const input = validate();
    if (!input) return;
    const value = { ...DEFAULT_COMMS_SETTINGS, ...input };
    if (!targets.length || !keys.length) {
      setError("Select channels and at least one setting.");
      return;
    }
    if (!canManage) {
      setError("Workspace management access is required.");
      return;
    }
    const result = await run(
      "management:apply",
      (draft) => {
        const previous = readCommsConfiguration(draft);
        const currentChannels = draft.read("commsChannels", CHANNELS);
        const currentCategories = draft.read("commsCategories", CATEGORIES);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentViewer = currentPeople.find(
          (person) => person.id === "sample-eli" && person.active,
        );
        if (
          !currentViewer ||
          !resolveCommsPermission(
            previous,
            { person: currentViewer },
            "manageWorkspace",
          ).allowed
        )
          return draft.reject("Workspace management access is required.");
        return stageCommsConfiguration(draft, () =>
          targets.reduce((next, channelId) => {
            const channel = currentChannels.find(
              (item) => item.id === channelId,
            );
            if (
              !channel ||
              !resolveCommsPermission(
                next,
                {
                  person: currentViewer,
                  channel,
                  categories: currentCategories,
                },
                "manageChannel",
              ).allowed
            )
              return next;
            const scope = { kind: "channel" as const, id: channel.id };
            const before = getCommsScope(next, scope);
            const settings = selectedSettings(
              value,
              keys.filter((key) => !next.lockedSettings.includes(key)),
            );
            return recordScopeChange(
              next,
              scope,
              { ...before, settings: { ...before.settings, ...settings } },
              `${view === "templates" ? name : "Bulk settings"} · ${channel.name}`,
            );
          }, previous),
        );
      },
      [
        COMMS_CONFIGURATION_KEY,
        "commsChannels",
        "commsCategories",
        "access-people",
      ],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "Selected settings could not be applied."),
    );
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setPreview(false);
    setEdited(false);
    setStatus(
      `Applied selected settings to ${selectedChannels.length} channel(s).`,
    );
  }
  async function saveTemplate() {
    setStatus("");
    if (!canManage) {
      setError("Workspace management access is required.");
      return;
    }
    const input = validate();
    if (!input) return;
    const settings = { ...input, ...selectedSettings(values, keys) };
    if (!name.trim()) {
      setError("A template name is required.");
      return;
    }
    const item = {
      id: active || crypto.randomUUID(),
      name: name.trim(),
      description,
      settings,
    };
    const result: TemplateSaveResult = await run<TemplateSaveResult>(
      `template:save:${item.id}`,
      (draft) => {
        const current = readCommsConfiguration(draft);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentViewer = currentPeople.find(
          (person) => person.id === "sample-eli" && person.active,
        );
        if (
          !currentViewer ||
          !resolveCommsPermission(
            current,
            { person: currentViewer },
            "manageWorkspace",
          ).allowed
        )
          return draft.reject({
            ok: false as const,
            error: "Workspace management access is required.",
          });
        const nextTemplates = current.templates.some(
          (template) => template.id === item.id,
        )
          ? current.templates.map((template) =>
              template.id === item.id ? item : template,
            )
          : [...current.templates, item];
        stageCommsConfiguration(draft, (value) => ({
          ...value,
          templates: nextTemplates,
        }));
        return { ok: true as const, templates: nextTemplates };
      },
      [COMMS_CONFIGURATION_KEY, "access-people"],
    ).catch((error: unknown) => ({
      ok: false as const,
      error: messageFromCommsError(error, "The template could not be saved."),
    }));
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTemplates(result.templates);
    setActive(item.id);
    setEdited(false);
    setStatus("Template saved.");
  }
  async function createInvites() {
    if (!canManage) {
      setError("Workspace management access is required.");
      return;
    }
    if (!invitePerson || !targets.length) {
      setError("Select a person and target channels.");
      return;
    }
    const result = await run(
      `membership:create:${invitePerson}`,
      (draft) => {
        const current = readCommsConfiguration(draft);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentViewer = currentPeople.find(
          (person) => person.id === "sample-eli" && person.active,
        );
        if (
          !currentViewer ||
          !resolveCommsPermission(
            current,
            { person: currentViewer },
            "manageWorkspace",
          ).allowed
        )
          return draft.reject("Workspace management access is required.");
        stageCommsConfiguration(draft, (current) => ({
          ...current,
          invites: [
            ...current.invites,
            ...targets
              .filter(
                (id) =>
                  !current.invites.some(
                    (invite) =>
                      invite.channelId === id &&
                      invite.personId === invitePerson &&
                      invite.status !== "declined",
                  ),
              )
              .map((id) => ({
                id: crypto.randomUUID(),
                channelId: id,
                personId: invitePerson,
                type: membershipType,
                status: "pending" as const,
              })),
          ],
        }));
        return null;
      },
      [COMMS_CONFIGURATION_KEY, "access-people"],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "Membership changes could not be saved."),
    );
    if (result) {
      setError(result);
      return;
    }
    setStatus(
      membershipType === "invite"
        ? "Invitations added here; none were sent."
        : "Join requests added here; none were sent.",
    );
  }
  async function updateInvite(
    inviteId: string,
    status: "accepted" | "declined",
  ) {
    const result = await run(
      `membership:${status}:${inviteId}`,
      (draft) => {
        const current = readCommsConfiguration(draft);
        const currentPeople = draft.read("access-people", initialPeople);
        const currentViewer = currentPeople.find(
          (person) => person.id === "sample-eli" && person.active,
        );
        if (
          !currentViewer ||
          !resolveCommsPermission(
            current,
            { person: currentViewer },
            "manageWorkspace",
          ).allowed
        )
          return draft.reject("Workspace management access is required.");
        if (!current.invites.some((invite) => invite.id === inviteId))
          return draft.reject("This membership request no longer exists.");
        stageCommsConfiguration(draft, (value) => ({
          ...value,
          invites: value.invites.map((invite) =>
            invite.id === inviteId ? { ...invite, status } : invite,
          ),
        }));
        return null;
      },
      [COMMS_CONFIGURATION_KEY, "access-people"],
    ).catch((error: unknown) =>
      messageFromCommsError(error, "Membership changes could not be saved."),
    );
    if (result) setError(result);
  }
  return (
    <ConfigurationFrame
      title={view === "templates" ? "Channel templates" : "Channel management"}
      description="Apply selected configuration fields without copying conversations or changing membership implicitly."
      opener={opener}
      onClose={onClose}
      dirty={edited}
      onSave={view === "templates" ? saveTemplate : undefined}
      saveLabel="Save template"
      disabled={!canManage}
      footer={
        <Button
          type="button"
          variant="outline"
          className="mr-auto min-h-11"
          disabled={!canManage}
          onClick={() => {
            const configuredKeys = [
              ...new Set([...Object.keys(parsed), ...keys]),
            ] as CommsSettingKey[];
            setJson(
              JSON.stringify(
                selectedSettings(DEFAULT_COMMS_SETTINGS, configuredKeys),
                null,
                2,
              ),
            );
            setEdited(true);
            setPreview(false);
            setError("");
            setStatus(
              "Default values staged. Save the template or preview and apply selected settings to keep them.",
            );
          }}
        >
          Reset to default
        </Button>
      }
    >
      <FieldGroup className="p-5 sm:p-6">
        {edited && view === "templates" && (
          <Button
            variant="outline"
            onClick={() => {
              if (selected) load(selected);
              else {
                setName("New template");
                setDescription("");
                setJson("{}");
                setKeys([]);
              }
              setEdited(false);
            }}
          >
            Discard template draft
          </Button>
        )}
        {!canManage && (
          <Alert role="alert" variant="warning">
            Workspace management access is required to change these settings.
          </Alert>
        )}
        {error && (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        )}
        {status && (
          <Alert role="status" variant="success">
            {status}
          </Alert>
        )}
        {view === "templates" && (
          <>
            <Field>
              <FieldLabel htmlFor="tools-management-field-1">
                Template
              </FieldLabel>
              <NativeSelect
                id="tools-management-field-1"
                className="w-full [&_select]:min-h-11"
                value={active}
                disabled={edited}
                onChange={(e) => {
                  const t = templates.find((t) => t.id === e.target.value);
                  if (t) load(t);
                }}
              >
                {templates.map((t) => (
                  <NativeSelectOption key={t.id} value={t.id}>
                    {t.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Button
              variant="outline"
              disabled={edited}
              onClick={() => {
                setActive("");
                setName("New template");
                setDescription("");
                changeJson("{}");
              }}
            >
              New template
            </Button>
            <Field>
              <FieldLabel htmlFor="tools-management-field-2">
                Template name
              </FieldLabel>
              <Input
                id="tools-management-field-2"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setEdited(true);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="tools-management-field-3">
                Description
              </FieldLabel>
              <Input
                id="tools-management-field-3"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setEdited(true);
                }}
              />
            </Field>
          </>
        )}
        <Collapsible>
          <Card className="w-full">
            <CardHeader>
              <CollapsibleTrigger
                render={
                  <Button variant="ghost" className="justify-between px-0" />
                }
              >
                Import or export settings{" "}
                <ChevronDown data-icon="inline-end" aria-hidden="true" />
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="flex flex-col gap-3">
                <Field>
                  <FieldLabel htmlFor="tools-management-field-4">
                    Settings JSON
                  </FieldLabel>
                  <Textarea
                    id="tools-management-field-4"
                    className="min-h-40 font-mono text-xs"
                    value={json}
                    onChange={(e) => changeJson(e.target.value)}
                    spellCheck={false}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      const settings = validate();
                      if (settings) {
                        setKeys(Object.keys(settings) as CommsSettingKey[]);
                        setStatus(
                          "Settings imported into your draft. Review selected fields before applying.",
                        );
                      }
                    }}
                  >
                    Validate import
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      const settings = validate();
                      if (!settings) return;
                      const blob = new Blob(
                        [JSON.stringify(settings, null, 2)],
                        {
                          type: "application/json",
                        },
                      );
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "opencomms-settings.json";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Export settings
                  </Button>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
        <Field>
          <FieldLabel htmlFor="tools-management-field-5">
            Find settings
          </FieldLabel>
          <Input
            id="tools-management-field-5"
            value={fieldSearch}
            onChange={(e) => setFieldSearch(e.target.value)}
          />
        </Field>
        <FieldSet className="grid max-h-56 grid-cols-1 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
          <FieldLegend>Fields to apply</FieldLegend>
          {!fields.length && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  Enter valid settings to choose individual fields.
                </EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {fields.map((key) => (
            <Field key={key} className="flex-row items-center gap-2">
              <Checkbox
                id={`tools-management-field-6-${key}`}
                checked={keys.includes(key)}
                disabled={config.lockedSettings.includes(key)}
                onCheckedChange={(checked) => {
                  setKeys(
                    checked ? [...keys, key] : keys.filter((k) => k !== key),
                  );
                  setPreview(false);
                }}
              />
              <FieldLabel htmlFor={`tools-management-field-6-${key}`}>
                {SETTINGS_LABELS[key]}
                {config.lockedSettings.includes(key) &&
                  " · Locked by workspace"}
              </FieldLabel>
            </Field>
          ))}
        </FieldSet>
        <SettingsFields
          keys={keys}
          values={values}
          overrides={parsed}
          sources={
            resolveCommsSettings(
              config,
              channels.find((c) => c.id === targets[0]),
              categories,
            ).sources
          }
          locked={config.lockedSettings}
          workspace={false}
          people={people}
          onChange={(key, value) => {
            setJson(JSON.stringify({ ...parsed, [key]: value }, null, 2));
            setEdited(true);
            setPreview(false);
          }}
        />

        {view === "management" && (
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Invitations and join requests</CardTitle>
              <CardDescription>
                Select target channels below, then invite a person. This does
                not send an invitation or change sign-in access.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Field>
                <FieldLabel htmlFor="tools-management-field-7">
                  Membership action
                </FieldLabel>
                <NativeSelect
                  id="tools-management-field-7"
                  className="w-full [&_select]:min-h-11"
                  value={membershipType}
                  onChange={(e) =>
                    setMembershipType(e.target.value as "invite" | "request")
                  }
                >
                  <NativeSelectOption value="invite">
                    Invitation
                  </NativeSelectOption>
                  <NativeSelectOption value="request">
                    Join request
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="tools-management-field-8">
                  Invite person
                </FieldLabel>
                <NativeSelect
                  id="tools-management-field-8"
                  className="w-full [&_select]:min-h-11"
                  value={invitePerson}
                  onChange={(e) => setInvitePerson(e.target.value)}
                >
                  <NativeSelectOption value="">
                    Select a person
                  </NativeSelectOption>
                  {people
                    .filter((p) => p.active)
                    .map((p) => (
                      <NativeSelectOption key={p.id} value={p.id}>
                        {p.name}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
              <Button variant="outline" onClick={() => void createInvites()}>
                {membershipType === "invite"
                  ? "Add invitations"
                  : "Add join requests"}
              </Button>
              {config.invites.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span>
                    {people.find((p) => p.id === invite.personId)?.name} · #
                    {channels.find((c) => c.id === invite.channelId)?.name} ·{" "}
                    {invite.type} · {invite.status}
                  </span>
                  {invite.status === "pending" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void updateInvite(invite.id, "accepted")}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void updateInvite(invite.id, "declined")}
                      >
                        Decline
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        <Field>
          <FieldLabel htmlFor="tools-management-field-9">
            Find channels
          </FieldLabel>
          <Input
            id="tools-management-field-9"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </Field>
        <FieldSet className="flex flex-col gap-2">
          <FieldLegend>Target channels</FieldLegend>
          {channels
            .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
            .map((c) => (
              <Field key={c.id} className="flex-row items-center gap-2">
                <Checkbox
                  id={`tools-management-field-10-${c.id}`}
                  checked={targets.includes(c.id)}
                  onCheckedChange={(checked) => {
                    setTargets(
                      checked
                        ? [...targets, c.id]
                        : targets.filter((id) => id !== c.id),
                    );
                    setPreview(false);
                    setEdited(true);
                  }}
                />
                <FieldLabel htmlFor={`tools-management-field-10-${c.id}`}>
                  #{c.name}
                  {c.archived ? " · Archived" : ""}
                </FieldLabel>
              </Field>
            ))}
        </FieldSet>
        <Button
          variant="outline"
          onClick={() => {
            if (!validate()) return;
            if (!targets.length || !keys.length) {
              setError("Select channels and at least one setting.");
              return;
            }
            setPreview(true);
          }}
        >
          Preview changes
        </Button>
        {preview && (
          <Card aria-label="Change preview" className="w-full">
            <CardHeader>
              <CardTitle>Change preview</CardTitle>
              <CardDescription>
                {selectedChannels.length} channels · {keys.length} selected
                fields. Permissions and membership stay unchanged unless
                explicitly selected.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {selectedChannels.map((c) => (
                <div key={c.id}>
                  <p className="font-medium">#{c.name}</p>
                  <p className="text-muted-foreground text-xs">
                    Applies to{" "}
                    {
                      people.filter(
                        (p) =>
                          resolveCommsPermission(
                            config,
                            { person: p, channel: c, categories },
                            "viewChannel",
                          ).allowed,
                      ).length
                    }{" "}
                    people across {roles.length} roles.
                  </p>
                  {keys.map((k) => (
                    <p key={k} className="text-xs break-words">
                      {SETTINGS_LABELS[k]}:{" "}
                      {JSON.stringify(
                        resolveCommsSettings(config, c, categories).values[k],
                      )}{" "}
                      → {JSON.stringify(picked[k])}
                    </p>
                  ))}
                </div>
              ))}
              <Separator />
              <Button onClick={apply} disabled={!canManage}>
                Apply selected settings
              </Button>
            </CardContent>
          </Card>
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
