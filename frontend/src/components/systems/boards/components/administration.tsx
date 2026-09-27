"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, FileUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SearchSelect } from "@/components/ui/search-select";
import {
  BOARD_INPUT_LIMITS,
  type Board,
  type BoardSection,
} from "../domain/model";
import { EditSheet, ConfirmAction } from "./ui";
import {
  exportBoardConfiguration,
  getBoardConfiguration,
  parseBoardConfiguration,
  type BoardConfiguration,
} from "../adapters/portability";
import type { BoardsController } from "../state/controller";

const sections = ["overview", "calendar", "announcements"].map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
}));
const blank: BoardConfiguration = {
  name: "",
  description: "",
  department: "Organization",
  defaultSection: "overview",
  widgets: [],
};

export function boardFromConfiguration(
  configuration: BoardConfiguration,
): Board {
  const now = new Date().toISOString();
  return {
    ...configuration,
    id: `sample-board-${crypto.randomUUID()}`,
    status: "active",
    visibleRoleIds: [],
    createdAt: now,
    updatedAt: now,
    widgets: configuration.widgets.map((widget) => ({
      ...structuredClone(widget),
      id: `board-widget-${crypto.randomUUID()}`,
      audience: { kind: "everyone" },
      permission: "Everyone",
    })),
  };
}

export function CreateBoardSheet({
  controller,
  initial,
  onClose,
  onCreated,
}: {
  controller: BoardsController;
  initial?: BoardConfiguration;
  onClose: () => void;
  onCreated: (board: Board) => void;
}) {
  const [configuration, setConfiguration] = useState<BoardConfiguration>(() =>
    initial
      ? { ...initial, name: `${initial.name.slice(0, 73)} (copy)` }
      : blank,
  );
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(initial ? "copy" : "blank");
  const dirty = JSON.stringify(configuration) !== JSON.stringify(blank);
  async function importFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("Choose a configuration smaller than 1 MiB.");
      return;
    }
    try {
      const result = parseBoardConfiguration(await file.text());
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfiguration(result.configuration);
      setSource("import");
    } catch {
      setError("This file could not be read. Choose it again.");
    }
  }
  async function create() {
    const board = boardFromConfiguration({
      ...configuration,
      name: configuration.name.trim(),
    });
    const result = await controller.run({ type: "create-board", board });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCreated(board);
  }
  return (
    <EditSheet
      open
      title="Create board"
      description="Start a private board, then choose who can view it in Board settings."
      dirty={dirty}
      pending={controller.isPending()}
      onClose={onClose}
    >
      <div className="space-y-6">
        {!initial && (
          <Tabs
            value={
              source === "import"
                ? "import"
                : source === "template"
                  ? "template"
                  : "blank"
            }
            onValueChange={(value) => setSource(String(value))}
          >
            <TabsList className="w-full">
              <TabsTrigger value="blank" className="min-h-11 flex-1">
                Blank
              </TabsTrigger>
              <TabsTrigger value="template" className="min-h-11 flex-1">
                Template
              </TabsTrigger>
              <TabsTrigger value="import" className="min-h-11 flex-1">
                Import
              </TabsTrigger>
            </TabsList>
            <TabsContent value="blank">
              <p className="text-muted-foreground text-sm">
                Choose a name and add widgets after creating your board.
              </p>
            </TabsContent>
            <TabsContent value="template" className="space-y-3">
              {controller.state.templates.length ? (
                <SearchSelect
                  label="Saved template"
                  value=""
                  placeholder="Choose a template"
                  options={controller.state.templates.map((template) => ({
                    value: template.id,
                    label: template.name,
                    description: `${template.widgets.length} widgets`,
                  }))}
                  onValueChange={(id) => {
                    const template = controller.state.templates.find(
                      (item) => item.id === id,
                    );
                    if (template)
                      setConfiguration(getBoardConfiguration(template));
                  }}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  No templates yet. Save a board’s structure from Board tools.
                </p>
              )}
            </TabsContent>
            <TabsContent value="import">
              <Field>
                <FieldLabel htmlFor="board-import">
                  <FileUp className="size-4" /> Configuration file
                </FieldLabel>
                <Input
                  id="board-import"
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    void importFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <FieldDescription>
                  Exported board configuration, up to 1 MiB.
                </FieldDescription>
              </Field>
            </TabsContent>
          </Tabs>
        )}
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field>
            <FieldLabel htmlFor="new-board-name">Board name</FieldLabel>
            <Input
              id="new-board-name"
              autoFocus
              required
              maxLength={80}
              value={configuration.name}
              onChange={(event) =>
                setConfiguration({ ...configuration, name: event.target.value })
              }
              placeholder="e.g. Operations updates"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-board-description">Description</FieldLabel>
            <Textarea
              id="new-board-description"
              maxLength={240}
              value={configuration.description}
              onChange={(event) =>
                setConfiguration({
                  ...configuration,
                  description: event.target.value,
                })
              }
              placeholder="What should people find here?"
            />
          </Field>
          <SearchSelect
            label="Department"
            value={configuration.department}
            options={(controller.lookup.departments ?? []).map((item) => ({
              value: item.name,
              label: item.name,
            }))}
            onValueChange={(department) =>
              setConfiguration({ ...configuration, department })
            }
          />
          <SearchSelect
            label="Opens to"
            value={configuration.defaultSection}
            options={sections}
            onValueChange={(value) =>
              setConfiguration({
                ...configuration,
                defaultSection: value as BoardSection,
              })
            }
          />
          <div className="bg-muted/50 space-y-2 rounded-lg border p-4 text-sm">
            <p className="font-medium">
              Ready to create · {configuration.widgets.length} widgets
            </p>
            <p className="text-muted-foreground">
              The new board is private to managers. Posts, events, files, linked
              records, personal preferences, and access rules are excluded.
            </p>
            {configuration.widgets.length > 0 && (
              <ul className="list-inside list-disc">
                {configuration.widgets.map((widget, index) => (
                  <li key={`${widget.name}-${index}`}>
                    {widget.name} · {widget.moduleId}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && (
            <Alert variant="destructive">
              <div>{error}</div>
            </Alert>
          )}
          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={controller.isPending() || !configuration.name.trim()}
          >
            <Plus />
            Create private board
          </Button>
        </form>
      </div>
    </EditSheet>
  );
}

export function BoardSettingsSheet({
  board,
  controller,
  onChange,
  onClose,
}: {
  board: Board;
  controller: BoardsController;
  onChange: (board: Board) => void;
  onClose: () => void;
}) {
  return (
    <EditSheet
      open
      title="Board settings"
      description="These changes join your board draft. Use Save board to apply them."
      dirty={false}
      pending={controller.isPending()}
      onClose={onClose}
    >
      <div className="space-y-6">
        <Field>
          <FieldLabel htmlFor="board-name">Board name</FieldLabel>
          <Input
            id="board-name"
            required
            maxLength={80}
            value={board.name}
            onChange={(event) =>
              onChange({ ...board, name: event.target.value })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="board-description">Description</FieldLabel>
          <Textarea
            id="board-description"
            maxLength={BOARD_INPUT_LIMITS.maxBoardDescription}
            value={board.description}
            onChange={(event) =>
              onChange({ ...board, description: event.target.value })
            }
          />
        </Field>
        <SearchSelect
          label="Department"
          value={board.department}
          options={(controller.lookup.departments ?? []).map((item) => ({
            value: item.name,
            label: item.name,
          }))}
          onValueChange={(department) => onChange({ ...board, department })}
        />
        <p className="text-muted-foreground -mt-3 text-sm">
          Department describes the board. Choose each widget’s data source
          separately.
        </p>
        <SearchSelect
          label="Default section"
          value={board.defaultSection}
          options={sections}
          onValueChange={(value) =>
            onChange({ ...board, defaultSection: value as BoardSection })
          }
        />
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">
            Roles that can view this board
          </legend>
          {(controller.lookup.roles ?? []).map((role) => (
            <label
              key={role.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm"
            >
              <Checkbox
                checked={board.visibleRoleIds.includes(role.id)}
                onCheckedChange={(checked) =>
                  onChange({
                    ...board,
                    visibleRoleIds: checked
                      ? [...board.visibleRoleIds, role.id]
                      : board.visibleRoleIds.filter((id) => id !== role.id),
                  })
                }
              />
              {role.name}
            </label>
          ))}
          {board.visibleRoleIds
            .filter(
              (id) => !controller.lookup.roles?.some((role) => role.id === id),
            )
            .map((id) => (
              <div
                key={id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>Unavailable role</span>
                <Button
                  variant="outline"
                  onClick={() =>
                    onChange({
                      ...board,
                      visibleRoleIds: board.visibleRoleIds.filter(
                        (role) => role !== id,
                      ),
                    })
                  }
                >
                  Remove reference
                </Button>
              </div>
            ))}
          <p className="text-muted-foreground text-sm">
            No selected roles makes the board private. Administrator access and
            additional rules from Access still apply.
          </p>
        </fieldset>
        <Button
          className="min-h-11 w-full"
          disabled={controller.isPending()}
          onClick={onClose}
        >
          Done · return to board draft
        </Button>
      </div>
    </EditSheet>
  );
}

export function BoardToolsSheet({
  board,
  controller,
  preview,
  onClose,
  onDuplicate,
  onPreviewChange,
}: {
  board: Board;
  controller: BoardsController;
  preview: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onPreviewChange: (identityId: string | null) => void;
}) {
  const [name, setName] = useState(board.name);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  function exportFile() {
    const url = URL.createObjectURL(
      new Blob([exportBoardConfiguration(board)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${board.name.replace(/[^a-z0-9-]/gi, "-") || "board"}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const commandPending = controller.isPending();
  const editable =
    !preview && !commandPending && controller.can(board.id, "manage");
  return (
    <EditSheet
      open
      title="Board tools"
      description="Reuse the structure and review recent board activity."
      dirty={false}
      pending={commandPending}
      onClose={onClose}
    >
      <Tabs defaultValue="access">
        <TabsList className="w-full">
          <TabsTrigger className="min-h-11 flex-1" value="access">
            Access
          </TabsTrigger>
          <TabsTrigger className="min-h-11 flex-1" value="reuse">
            Reuse
          </TabsTrigger>
          <TabsTrigger className="min-h-11 flex-1" value="activity">
            Activity
          </TabsTrigger>
        </TabsList>
        <TabsContent value="access" className="space-y-5">
          <SearchSelect
            label="Preview as"
            value={preview ? controller.actorId : "manager"}
            options={[
              { value: "manager", label: "Mara · authoring" },
              ...controller.people
                .filter((person) => person.active)
                .map((person) => ({
                  value: person.id,
                  label: `${person.name} · read-only`,
                })),
            ]}
            onValueChange={(id) =>
              onPreviewChange(id === "manager" ? null : id)
            }
          />
          <div className="flex flex-wrap gap-2">
            {(["view", "edit", "manage"] as const).map((permission) => (
              <Badge
                key={permission}
                variant={
                  controller.can(board.id, permission) ? "secondary" : "outline"
                }
              >
                {permission}:{" "}
                {controller.can(board.id, permission)
                  ? "allowed"
                  : "unavailable"}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">
            Effective permissions for{" "}
            {controller.viewer?.name ?? "this identity"}. Preview as is always
            read-only. Archived boards keep their access rules and pause content
            changes.
          </p>
          <p className="text-sm">
            Visible roles:{" "}
            {board.visibleRoleIds
              .map(
                (id) =>
                  controller.lookup.roles?.find((role) => role.id === id)
                    ?.name ?? "Unavailable role",
              )
              .join(", ") || "Managers only"}
          </p>
          <Link
            className="text-primary inline-flex min-h-11 items-center underline underline-offset-4"
            href={`/access?view=people&user=${encodeURIComponent(controller.actorId)}`}
          >
            Review {controller.viewer?.name ?? "identity"} in Access
          </Link>
        </TabsContent>
        <TabsContent value="reuse" className="space-y-6">
          <p className="text-muted-foreground text-sm">
            Reuse names, layout, sources, fields, and filters. Content, file
            bytes, and access grants stay with the original board.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              variant="outline"
              disabled={!editable || commandPending}
              onClick={onDuplicate}
            >
              Duplicate structure
            </Button>
            <Button variant="outline" disabled={!editable} onClick={exportFile}>
              <Download />
              Export configuration
            </Button>
          </div>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              const now = new Date().toISOString();
              const result = await controller.run({
                type: "save-template",
                template: {
                  ...board,
                  id: `board-template-${crypto.randomUUID()}`,
                  name: name.trim(),
                  createdAt: now,
                  updatedAt: now,
                },
              });
              setMessage(
                result.ok
                  ? "Template saved. Use it from Create board → Template."
                  : result.error,
              );
            }}
          >
            <Field>
              <FieldLabel htmlFor="board-template-name">
                Save as a template
              </FieldLabel>
              <Input
                id="board-template-name"
                maxLength={80}
                required
                disabled={!editable || commandPending}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={!editable || commandPending || !name.trim()}
            >
              Save template
            </Button>
          </form>
          {controller.state.templates.map((template) => (
            <div
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              key={template.id}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{template.name}</p>
                <p className="text-muted-foreground text-xs">
                  {template.widgets.length} widgets
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label={`Delete template ${template.name}`}
                disabled={!editable}
                onClick={() => setDeleting(template.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}
        </TabsContent>
        <TabsContent value="activity" className="space-y-4">
          <p className="text-muted-foreground text-sm">
            The workspace keeps its latest 100 activity entries. Showing this
            board only.
          </p>
          {controller.state.activity.filter(
            (entry) => entry.boardId === board.id,
          ).length === 0 && (
            <p className="text-sm">
              No activity yet. Saved changes will appear here.
            </p>
          )}
          <ol className="space-y-4">
            {controller.state.activity
              .filter((entry) => entry.boardId === board.id)
              .map((entry) => (
                <li key={entry.id} className="border-l-2 pl-4">
                  <p className="text-sm font-medium">{entry.action}</p>
                  <p className="text-muted-foreground text-sm break-words">
                    {entry.detail}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {controller.lookup.identities?.find(
                      (person) => person.id === entry.actorId,
                    )?.name ?? "Unavailable identity"}{" "}
                    ·{" "}
                    {new Intl.DateTimeFormat(controller.locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: controller.timezone,
                    }).format(new Date(entry.createdAt))}
                  </p>
                </li>
              ))}
          </ol>
        </TabsContent>
      </Tabs>
      <ConfirmAction
        open={deleting !== null}
        title="Delete this template?"
        description="Boards created from this template remain available."
        action="Delete template"
        onCancel={() => setDeleting(null)}
        disabled={commandPending}
        onConfirm={() => {
          if (!deleting) return;
          void controller
            .run({
              type: "delete-template",
              templateId: deleting,
            })
            .then((result) => {
              setMessage(result.ok ? "Template deleted." : result.error);
              if (result.ok) setDeleting(null);
            });
        }}
      />
    </EditSheet>
  );
}
