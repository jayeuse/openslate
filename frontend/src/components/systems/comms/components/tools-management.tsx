"use client";
import { useRef, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { ToolAdvanced } from "./tool-advanced";
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
import { parseTemplateImport } from "../domain/template-import";
import {
  ConfigurationFrame,
  type ConfigurationFrameProps,
} from "./configuration-frame";
import { SettingsFields, SETTINGS_LABELS } from "./settings-fields";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import {
  useCommsRead,
  useCommsCommands,
  messageFromCommsError,
  isCommsConflict,
  STALE_PREVIEW_MESSAGE,
} from "../state/runtime";
import { complete } from "../state/workspace-view";
import { wireSettingKey, wireSettings } from "../state/settings-wire";

export function ManagementTools({
  embedded,
  channelId,
  opener,
  onClose,
}: {
  embedded?: ConfigurationFrameProps["embedded"];
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
      return { templates };
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
      if (isCommsConflict(failure)) setPreview(undefined);
      setError(
        messageFromCommsError(
          failure,
          "The settings could not be applied. Preview the current state again.",
          STALE_PREVIEW_MESSAGE,
        ),
      );
    }
  }
  function resetDefaults() {
    const reset = Object.fromEntries(
      [...new Set([...Object.keys(settingsView(parsed)), ...keys])].map(
        (key) => [key, DEFAULT_COMMS_SETTINGS[key as CommsSettingKey]],
      ),
    );
    changeJson(JSON.stringify(wireSettings(reset), null, 2));
    setStatus(
      "Default values staged. Save the template before previewing changes.",
    );
  }
  const editor = (
    <ToolAdvanced tool="templates" count={Number(edited)}>
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
      <Field>
        <FieldLabel htmlFor="tools-settings-json">Settings JSON</FieldLabel>
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
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(parse().settings, null, 2)], {
                  type: "application/json",
                }),
              );
              try {
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "opencomms-settings.json";
                anchor.click();
              } finally {
                URL.revokeObjectURL(url);
              }
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
                if (checked && !Object.hasOwn(parsed, wireSettingKey(key)))
                  changeJson(
                    JSON.stringify(
                      { ...parsed, ...wireSettings({ [key]: values[key] }) },
                      null,
                      2,
                    ),
                  );
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
      <Button
        variant="outline"
        disabled={!canManage || isPending()}
        onClick={resetDefaults}
      >
        Reset to default
      </Button>
    </ToolAdvanced>
  );
  return (
    <ConfigurationFrame
      embedded={embedded}
      className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
      title="Channel templates"
      description="Copy chosen settings from a saved template to several channels. Messages and members stay as they are."
      opener={opener}
      onClose={onClose}
      dirty={edited}
      onSave={edited ? saveTemplate : undefined}
      saveLabel="Save template"
      disabled={!canManage || isPending()}
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
                <FieldLabel
                  htmlFor={`tools-target-${channel.id}`}
                  className="min-h-11 flex-1"
                >
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
                      {JSON.stringify(item.before[key]) ?? "Inherited"} →{" "}
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
        {editor}
      </FieldGroup>
    </ConfigurationFrame>
  );
}
