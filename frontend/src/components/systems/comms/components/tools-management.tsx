"use client";
import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
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
import type * as C from "../contract/types";
import {
  DEFAULT_COMMS_SETTINGS,
  settingsView,
  type CommsSettingKey,
} from "../domain/configuration";
import { parseTemplateImport } from "../memory/template-import";
import { ConfigurationFrame } from "./configuration-frame";
import { SettingsFields, SETTINGS_LABELS } from "./settings-fields";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import {
  useCommsRead,
  useCommsCommands,
  messageFromCommsError,
} from "../state/runtime";
import { complete } from "../state/workspace-view";
import { wireSettingKey, wireSettings } from "../state/settings-wire";

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
  const workspace = useCommsWorkspaceView();
  const { channels, people, configuration: config } = workspace;
  const { run, isPending } = useCommsCommands();
  const canManage = Object.values(workspace.checks).some(
    (check) => check.capabilities.manageWorkspace.allowed,
  );
  const [active, setActive] = useState("");
  const version = useRef<string | null>(null);
  const acceptedTemplate = useRef<C.Versioned<C.Template> | null>(null);
  const [name, setName] = useState("New template");
  const [description, setDescription] = useState("");
  const [json, setJson] = useState("{}");
  const [keys, setKeys] = useState<CommsSettingKey[]>([]);
  const [targets, setTargets] = useState<string[]>(
    channelId ? [channelId] : [],
  );
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [filter, setFilter] = useState("");
  const [fieldSearch, setFieldSearch] = useState("");
  const [invitePerson, setInvitePerson] = useState("");
  const [membershipType, setMembershipType] = useState<"invite" | "request">(
    "invite",
  );
  const [preview, setPreview] = useState<{
    templateId: string;
    request: C.TemplateApplyRequest;
    response: C.Versioned<C.TemplateApplyPreview>;
  }>();
  const resource = useCommsRead(
    `management:${targets.join(":")}`,
    async (client, signal) => {
      const templates = await complete((offset) =>
        client.listTemplates({ limit: 100, offset }, { signal }),
      );
      const admissions: C.Admission[] = [];
      if (view === "management")
        for (const channel of channels.filter(
          (channel) =>
            targets.includes(channel.id) && channel.scope === "members",
        ))
          admissions.push(
            ...(await complete((offset) =>
              client.listAdmissions(
                channel.id,
                { limit: 100, offset },
                { signal },
              ),
            )),
          );
      return { templates, admissions };
    },
  );
  function parse() {
    return parseTemplateImport(
      `{"name":${JSON.stringify(name)},"description":${JSON.stringify(description)},"settings":${json}}`,
    );
  }
  let parsed: C.TemplateImport["settings"] = {};
  try {
    parsed = parse().settings;
  } catch {
    /* Invalid JSON stays editable; commands refuse it. */
  }
  const values = { ...DEFAULT_COMMS_SETTINGS, ...settingsView(parsed) };
  const fields = (
    Object.keys(DEFAULT_COMMS_SETTINGS) as CommsSettingKey[]
  ).filter(
    (key) =>
      key !== "dmRule" &&
      SETTINGS_LABELS[key].toLowerCase().includes(fieldSearch.toLowerCase()),
  );
  function changeJson(value: string) {
    setJson(value);
    setPreview(undefined);
    setEdited(true);
  }
  async function load(id: string) {
    setError("");
    try {
      const template = await run(`template-read:${id}`, (client, signal) =>
        client.getTemplate(id, { signal }),
      );
      setActive(id);
      version.current = template.etag;
      acceptedTemplate.current = template;
      setName(template.data.name);
      setDescription(template.data.description);
      setJson(JSON.stringify(template.data.settings, null, 2));
      setKeys(
        Object.keys(settingsView(template.data.settings)) as CommsSettingKey[],
      );
      setEdited(false);
      setPreview(undefined);
    } catch (failure) {
      setError(
        messageFromCommsError(failure, "The template could not be loaded."),
      );
    }
  }
  async function saveTemplate() {
    setError("");
    setStatus("");
    try {
      const request = parse();
      const template = await run("template-save", async (client, signal) => {
        const id = active || acceptedTemplate.current?.data.id;
        const etag = version.current ?? acceptedTemplate.current?.etag;
        const result =
          id && etag
            ? await client.saveTemplate(id, request, { signal, if_match: etag })
            : await client.createTemplate(request, { signal });
        acceptedTemplate.current = result;
        version.current = result.etag;
        return result;
      });
      setActive(template.data.id);
      setEdited(false);
      setStatus("Template saved.");
      resource.reload();
      return true;
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The template could not be saved. Your draft is still here.",
        ),
      );
      return false;
    }
  }
  async function previewChanges() {
    if (edited || !active) {
      setError("Save the template before previewing changes.");
      return;
    }
    if (!targets.length || !keys.length) {
      setError("Select channels and at least one setting.");
      return;
    }
    setError("");
    try {
      const request = {
        conversation_ids: targets,
        keys: keys.map(wireSettingKey),
        capability_keys: [],
      };
      const response = await run("template-preview", (client, signal) =>
        client.previewTemplateApply(active, request, { signal }),
      );
      setPreview({ templateId: active, request, response });
    } catch (failure) {
      setError(
        messageFromCommsError(failure, "The changes could not be previewed."),
      );
    }
  }
  async function apply() {
    if (!preview) return;
    setError("");
    try {
      await run("template-apply", async (client, signal) => {
        await client.applyTemplate(preview.templateId, preview.request, {
          signal,
          if_match: preview.response.etag,
        });
        setPreview(undefined);
      });
      setStatus("Selected settings applied.");
      resource.reload();
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The settings could not be applied. Preview the current state again.",
        ),
      );
    }
  }
  async function createInvites() {
    setError("");
    setStatus("");
    let completed = 0;
    try {
      await run("admissions-create", async (client, signal) => {
        if (
          !targets.length ||
          targets.some(
            (id) =>
              channels.find((channel) => channel.id === id)?.scope !==
              "members",
          )
        )
          throw new Error("Choose private channels");
        for (const id of targets) {
          if (membershipType === "invite")
            await client.invitePerson(
              id,
              { user_id: invitePerson },
              { signal },
            );
          else
            await client.submitJoinRequest({ conversation_id: id }, { signal });
          completed += 1;
        }
      });
      setStatus(
        membershipType === "invite"
          ? "Invitations created."
          : "Join requests submitted for your account.",
      );
      resource.reload();
    } catch (failure) {
      setError(
        completed
          ? "Some requests were submitted. Reload the current requests before submitting more."
          : messageFromCommsError(
              failure,
              "Requests could not be submitted. Select private channels and a person for invitations.",
            ),
      );
    }
  }
  async function decide(invite: C.Admission, decision: "accept" | "decline") {
    setError("");
    try {
      await run(`admission:${invite.id}`, async (client, signal) => {
        const current = await client.getAdmission(
          invite.conversation_id,
          invite.id,
          { signal },
        );
        await client.decideAdmission(
          invite.conversation_id,
          invite.id,
          { decision },
          { signal, if_match: current.etag },
        );
      });
      resource.reload();
    } catch (failure) {
      setError(
        messageFromCommsError(failure, "The request could not be updated."),
      );
    }
  }
  return (
    <ConfigurationFrame
      title={
        view === "templates" ? "Channel templates" : "Bulk channel changes"
      }
      description="Copy chosen settings from a saved template to several channels. Messages and members stay as they are."
      opener={opener}
      onClose={onClose}
      dirty={edited}
      onSave={saveTemplate}
      saveLabel="Save template"
      disabled={!canManage || isPending()}
      footer={
        <Button
          type="button"
          variant="outline"
          className="mr-auto min-h-11"
          disabled={!canManage || isPending()}
          onClick={() => {
            const reset = Object.fromEntries(
              [...new Set([...Object.keys(settingsView(parsed)), ...keys])].map(
                (key) => [key, DEFAULT_COMMS_SETTINGS[key as CommsSettingKey]],
              ),
            );
            setJson(JSON.stringify(wireSettings(reset), null, 2));
            setEdited(true);
            setPreview(undefined);
            setStatus(
              "Default values staged. Save the template before previewing changes.",
            );
          }}
        >
          Reset to default
        </Button>
      }
    >
      <FieldGroup className="p-5 sm:p-6">
        {edited && (
          <Button
            variant="outline"
            onClick={() => {
              if (active) void load(active);
              else {
                setName("New template");
                setDescription("");
                setJson("{}");
                setKeys([]);
                setEdited(false);
              }
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
        {(error || resource.error) && (
          <Alert role="alert" variant="destructive">
            {error || "Templates could not be loaded."}
            {resource.error && (
              <Button variant="outline" onClick={resource.reload}>
                Try again
              </Button>
            )}
          </Alert>
        )}
        {status && (
          <Alert role="status" variant="success">
            {status}
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="tools-template">Template</FieldLabel>
          <NativeSelect
            id="tools-template"
            className="w-full [&_select]:min-h-11"
            value={active}
            disabled={edited || isPending()}
            onChange={(event) => void load(event.target.value)}
          >
            <NativeSelectOption value="">Choose a template</NativeSelectOption>
            {resource.data?.templates.map((template) => (
              <NativeSelectOption key={template.id} value={template.id}>
                {template.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Button
          variant="outline"
          disabled={edited || isPending()}
          onClick={() => {
            setActive("");
            version.current = null;
            acceptedTemplate.current = null;
            setName("New template");
            setDescription("");
            changeJson("{}");
            setKeys([]);
          }}
        >
          New template
        </Button>
        <Field>
          <FieldLabel htmlFor="tools-template-name">Template name</FieldLabel>
          <Input
            id="tools-template-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setEdited(true);
              setPreview(undefined);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="tools-template-description">
            Description
          </FieldLabel>
          <Input
            id="tools-template-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setEdited(true);
              setPreview(undefined);
            }}
          />
        </Field>
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
                  <FieldLabel htmlFor="tools-settings-json">
                    Settings JSON
                  </FieldLabel>
                  <Textarea
                    id="tools-settings-json"
                    className="min-h-40 font-mono text-xs"
                    value={json}
                    onChange={(event) => changeJson(event.target.value)}
                    spellCheck={false}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      try {
                        setKeys(
                          Object.keys(
                            settingsView(parse().settings),
                          ) as CommsSettingKey[],
                        );
                        setStatus(
                          "Settings imported into your draft. Save before applying.",
                        );
                        setError("");
                      } catch {
                        setError(
                          "Settings JSON is invalid or contains unsupported fields.",
                        );
                      }
                    }}
                  >
                    Validate import
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      try {
                        const blob = new Blob(
                          [JSON.stringify(parse().settings, null, 2)],
                          { type: "application/json" },
                        );
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = "opencomms-settings.json";
                        anchor.click();
                        URL.revokeObjectURL(url);
                      } catch {
                        setError(
                          "Settings JSON is invalid or contains unsupported fields.",
                        );
                      }
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
          <FieldLabel htmlFor="tools-find-settings">Find settings</FieldLabel>
          <Input
            id="tools-find-settings"
            value={fieldSearch}
            onChange={(event) => setFieldSearch(event.target.value)}
          />
        </Field>
        <FieldSet className="grid max-h-56 grid-cols-1 gap-2 overflow-auto rounded-md border p-3 sm:grid-cols-2">
          <FieldLegend>Fields to apply</FieldLegend>
          {fields.map((key) => (
            <Field key={key} className="flex-row items-center gap-2">
              <Checkbox
                id={`tools-field-${key}`}
                checked={keys.includes(key)}
                disabled={config.lockedSettings.includes(key)}
                onCheckedChange={(checked) => {
                  setKeys(
                    checked
                      ? [...keys, key]
                      : keys.filter((item) => item !== key),
                  );
                  if (checked && !Object.hasOwn(parsed, wireSettingKey(key))) {
                    setJson(
                      JSON.stringify(
                        { ...parsed, ...wireSettings({ [key]: values[key] }) },
                        null,
                        2,
                      ),
                    );
                    setEdited(true);
                  }
                  setPreview(undefined);
                }}
              />
              <FieldLabel htmlFor={`tools-field-${key}`}>
                {SETTINGS_LABELS[key]}
                {config.lockedSettings.includes(key)
                  ? " · Locked by workspace"
                  : ""}
              </FieldLabel>
            </Field>
          ))}
        </FieldSet>
        <SettingsFields
          keys={keys}
          values={values}
          overrides={settingsView(parsed)}
          locked={config.lockedSettings}
          workspace={false}
          people={people}
          onChange={(key, value) =>
            changeJson(
              JSON.stringify(
                { ...parsed, ...wireSettings({ [key]: value }) },
                null,
                2,
              ),
            )
          }
        />
        {view === "management" && (
          <Card className="w-full">
            <CardHeader>
              <CardTitle>Invitations and join requests</CardTitle>
              <CardDescription>
                Select private target channels below. Join requests are
                submitted only for your own account.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Field>
                <FieldLabel htmlFor="tools-membership-action">
                  Membership action
                </FieldLabel>
                <NativeSelect
                  id="tools-membership-action"
                  className="w-full [&_select]:min-h-11"
                  value={membershipType}
                  onChange={(event) =>
                    setMembershipType(
                      event.target.value === "invite" ? "invite" : "request",
                    )
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
              {membershipType === "invite" && (
                <Field>
                  <FieldLabel htmlFor="tools-invite-person">
                    Invite person
                  </FieldLabel>
                  <NativeSelect
                    id="tools-invite-person"
                    className="w-full [&_select]:min-h-11"
                    value={invitePerson}
                    onChange={(event) => setInvitePerson(event.target.value)}
                  >
                    <NativeSelectOption value="">
                      Select a person
                    </NativeSelectOption>
                    {people.map((person) => (
                      <NativeSelectOption key={person.id} value={person.id}>
                        {person.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <Button
                variant="outline"
                disabled={isPending()}
                onClick={() => void createInvites()}
              >
                {membershipType === "invite"
                  ? "Add invitations"
                  : "Request to join"}
              </Button>
              {resource.data?.admissions.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center gap-2 text-sm"
                >
                  <span>
                    {people.find((person) => person.id === invite.user_id)
                      ?.name ?? "Unavailable person"}{" "}
                    · #
                    {
                      channels.find(
                        (channel) => channel.id === invite.conversation_id,
                      )?.name
                    }{" "}
                    · {invite.kind} · {invite.status}
                  </span>
                  {invite.status === "pending" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending()}
                        onClick={() => void decide(invite, "accept")}
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending()}
                        onClick={() => void decide(invite, "decline")}
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
          <FieldLabel htmlFor="tools-find-channels">Find channels</FieldLabel>
          <Input
            id="tools-find-channels"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </Field>
        <FieldSet className="flex flex-col gap-2">
          <FieldLegend>Target channels</FieldLegend>
          {channels
            .filter((channel) =>
              channel.name.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((channel) => (
              <Field key={channel.id} className="flex-row items-center gap-2">
                <Checkbox
                  id={`tools-target-${channel.id}`}
                  checked={targets.includes(channel.id)}
                  onCheckedChange={(checked) => {
                    setTargets(
                      checked
                        ? [...targets, channel.id]
                        : targets.filter((id) => id !== channel.id),
                    );
                    setPreview(undefined);
                  }}
                />
                <FieldLabel htmlFor={`tools-target-${channel.id}`}>
                  #{channel.name}
                  {channel.archived ? " · Archived" : ""}
                </FieldLabel>
              </Field>
            ))}
        </FieldSet>
        <Button
          variant="outline"
          disabled={isPending()}
          onClick={() => void previewChanges()}
        >
          Preview changes
        </Button>
        {preview && (
          <Card aria-label="Change preview" className="w-full">
            <CardHeader>
              <CardTitle>Change preview</CardTitle>
              <CardDescription>
                {preview.response.data.items.length} channels · {keys.length}{" "}
                selected fields. Membership stays unchanged.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {preview.response.data.items.map((item) => (
                <div key={item.conversation_id}>
                  <p className="font-medium">
                    #
                    {
                      channels.find(
                        (channel) => channel.id === item.conversation_id,
                      )?.name
                    }
                  </p>
                  {preview.request.keys.map((key) => (
                    <p key={key} className="text-xs break-words">
                      {key.replaceAll("_", " ")}:{" "}
                      {JSON.stringify(item.before[key])} →{" "}
                      {JSON.stringify(item.after[key])}
                      {item.skipped_locked_keys.includes(key)
                        ? " · Locked by workspace"
                        : ""}
                    </p>
                  ))}
                </div>
              ))}
              <Separator />
              <Button
                onClick={() => void apply()}
                disabled={!canManage || isPending()}
              >
                Apply selected settings
              </Button>
            </CardContent>
          </Card>
        )}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
