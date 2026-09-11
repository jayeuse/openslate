import { useState, useEffect, useRef, type ReactNode } from "react";
import { Plus, ArrowUp, ArrowDown, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  SandboxCanvas,
  type SandboxCanvasApi,
  type SandboxCanvasLayout,
  type SandboxDropKind,
} from "@/components/sandbox/sandbox-canvas";
import {
  SandboxInspector,
  type SandboxInspectorTarget,
} from "@/components/sandbox/sandbox-inspector";
import type { SandboxFieldType } from "@/lib/sandbox/model";
import {
  canvasFieldId,
  projectDesign,
  sampleField,
  sampleTypes,
  updateProjectedField,
} from "./bridge";

import {
  counts,
  compactDefaultLayout,
  reorder,
  uid,
  type Design,
  type DesignUpdate,
  type Field,
} from "./model";

export function Control({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-2 text-xs font-medium">
      {label}
      {children}
    </label>
  );
}
export const selectClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";
export function Designer({
  initialSelected,
  design,
  change,
  initializeLayout,
  notify,
}: {
  initialSelected: string;
  design: Design;
  change: (d: DesignUpdate) => void;
  initializeLayout: (layout: SandboxCanvasLayout) => void;
  notify: (s: string) => void;
}) {
  const [pane, setPane] = useState("Structure");
  const graphRef = useRef<SandboxCanvasApi | null>(null);
  const canvasFrameRef = useRef<HTMLDivElement>(null);
  const pendingMove = useRef<{ id: string; department: string } | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<SandboxInspectorTarget | null>(null);
  const structureSignature = JSON.stringify([
    design.departments.map((item) => item.id),
    design.modules.map((item) => [
      item.id,
      item.department,
      item.fields.map((field) => field.id),
    ]),
  ]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (graphRef.current) initializeLayout(graphRef.current.getLayout());
    });
    return () => cancelAnimationFrame(frame);
  }, [structureSignature, initializeLayout]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (canvasFrameRef.current?.clientWidth) graphRef.current?.fit();
    });
    return () => cancelAnimationFrame(frame);
  }, [pane]);
  function selectItem(id: string) {
    setSelected(id);
    setPane("Inspector");
  }
  const [selected, setSelected] = useState(initialSelected);
  const [editor, setEditor] = useState("");
  const [editingRelationship, setEditingRelationship] = useState<string | null>(
    null,
  );
  const [name, setName] = useState("");
  const [type, setType] = useState("Text");
  const [required, setRequired] = useState(false);
  const [value, setValue] = useState("");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState("sample-equipment");
  const [cardinality, setCardinality] = useState("One-to-many");
  const selectedField = sampleField(design, selected);
  const selectedRelationship = design.relationships.find(
    (item) => item.id === selected,
  );
  const selectedModule = design.modules.find(
    (m) =>
      m.id ===
      (selectedField?.moduleId ?? selectedRelationship?.source ?? selected),
  );
  const projected = projectDesign(design, selected);
  function renameDepartment(id: string, nextName: string) {
    change((previous) => ({
      ...previous,
      departments: previous.departments.map((item) =>
        item.id === id ? { ...item, name: nextName } : item,
      ),
    }));
  }
  function renameModule(id: string, nextName: string) {
    change((previous) => ({
      ...previous,
      modules: previous.modules.map((item) =>
        item.id === id ? { ...item, name: nextName } : item,
      ),
    }));
  }
  function moveModule(id: string, departmentId: string) {
    change((previous) => ({
      ...previous,
      modules: previous.modules.map((item) =>
        item.id === id ? { ...item, department: departmentId } : item,
      ),
    }));
  }
  function addFromCanvas(
    kind: SandboxDropKind,
    parentId: string | null,
    fieldType: SandboxFieldType = "text",
    position?: { x: number; y: number },
  ) {
    const id = uid();
    if (kind === "department")
      change((previous) => ({
        ...previous,
        departments: [
          ...previous.departments,
          { id, name: "New department", closed: false },
        ],
      }));
    if (kind === "module" && parentId)
      change((previous) => ({
        ...previous,
        modules: [
          ...previous.modules,
          {
            id,
            department: parentId,
            name: "New module",
            closed: false,
            fields: [],
            x: 0,
            y: 0,
          },
        ],
      }));
    if (kind === "field" && parentId)
      change((previous) => ({
        ...previous,
        modules: previous.modules.map((item) =>
          item.id === parentId
            ? {
                ...item,
                fields: [
                  ...item.fields,
                  {
                    id,
                    name: `${sampleTypes[fieldType]} field`,
                    type: sampleTypes[fieldType],
                    required: false,
                    value: "",
                    options: "",
                    closed: false,
                  },
                ],
              }
            : item,
        ),
      }));
    setSelected(
      kind === "field" && parentId ? canvasFieldId(parentId, id) : id,
    );
    if (position && kind !== "field") graphRef.current?.placeNode(id, position);
  }
  function connectModules(sourceId: string, targetId: string) {
    setSelected(sourceId);
    open("relationship");
    setTarget(targetId);
  }
  function removeSelected() {
    if (!deleteTarget) return;
    change((previous) => {
      const field = sampleField(previous, deleteTarget.id);
      if (deleteTarget.kind === "field" && field)
        return {
          ...previous,
          modules: previous.modules.map((item) =>
            item.id === field.moduleId
              ? {
                  ...item,
                  fields: item.fields.filter(
                    (entry) => entry.id !== field.field.id,
                  ),
                }
              : item,
          ),
        };
      if (deleteTarget.kind === "link")
        return {
          ...previous,
          relationships: previous.relationships.filter(
            (item) => item.id !== deleteTarget.id,
          ),
        };
      const removed = new Set(
        previous.modules
          .filter((item) =>
            deleteTarget.kind === "department"
              ? item.department === deleteTarget.id
              : item.id === deleteTarget.id,
          )
          .map((item) => item.id),
      );
      return {
        ...previous,
        departments: previous.departments.filter(
          (item) =>
            deleteTarget.kind !== "department" || item.id !== deleteTarget.id,
        ),
        modules: previous.modules.filter((item) => !removed.has(item.id)),
        relationships: previous.relationships.filter(
          (item) => !removed.has(item.source) && !removed.has(item.target),
        ),
      };
    });
    setDeleteTarget(null);
    setSelected("");
    notify("Item deleted from sample design. Undo restores it.");
  }
  const department =
    design.departments.find(
      (d) => d.id === (selectedModule?.department ?? selected),
    ) ?? design.departments[0];
  function open(kind: string) {
    setEditor(kind);
    setEditingRelationship(null);
    setPane("Inspector");
    setName(
      kind === "rename" ? (selectedModule?.name ?? department?.name ?? "") : "",
    );
    setType("Text");
    setRequired(false);
    setValue("");
    setOptions("");
  }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (editor === "department") {
      const id = uid();
      change({
        ...design,
        departments: [
          ...design.departments,
          { id, name: name.trim(), closed: false },
        ],
      });
      setSelected(id);
    }
    if (editor === "module" && department) {
      const id = uid();
      change({
        ...design,
        modules: [
          ...design.modules,
          {
            id,
            name: name.trim(),
            department: department.id,
            closed: false,
            fields: [],
            x: 0,
            y: 0,
          },
        ],
      });
      setSelected(id);
    }
    if (editor === "rename")
      change(
        selectedModule
          ? {
              ...design,
              modules: design.modules.map((m) =>
                m.id === selectedModule.id ? { ...m, name: name.trim() } : m,
              ),
            }
          : {
              ...design,
              departments: design.departments.map((d) =>
                d.id === department?.id ? { ...d, name: name.trim() } : d,
              ),
            },
      );
    if (editor === "field" && selectedModule) {
      const field: Field = {
        id: uid(),
        name: name.trim(),
        type,
        required,
        value,
        options,
        closed: false,
      };
      change({
        ...design,
        modules: design.modules.map((m) =>
          m.id === selectedModule.id
            ? { ...m, fields: [...m.fields, field] }
            : m,
        ),
      });
    }
    if (editor === "relationship" && selectedModule && target) {
      change((previous) => ({
        ...previous,
        relationships: editingRelationship
          ? previous.relationships.map((item) =>
              item.id === editingRelationship
                ? { ...item, name: name.trim(), target, cardinality }
                : item,
            )
          : [
              ...previous.relationships,
              {
                id: uid(),
                name: name.trim(),
                source: selectedModule.id,
                target,
                cardinality,
              },
            ],
      }));
    }
    setEditor("");
    if (editor === "department" || editor === "module") setPane("Structure");
    notify(`${name.trim()} saved in the sample design.`);
  }
  function updateField(id: string, patch: Partial<Field>) {
    if (selectedModule)
      change({
        ...design,
        modules: design.modules.map((m) =>
          m.id === selectedModule.id
            ? {
                ...m,
                fields: m.fields.map((f) =>
                  f.id === id ? { ...f, ...patch } : f,
                ),
              }
            : m,
        ),
      });
  }
  const editorForm = (
    <form onSubmit={submit} className="space-y-4">
      <h3 className="font-semibold">
        {editor === "rename" ? "Rename item" : `Create ${editor}`}
      </h3>
      <Control
        label={`${editor === "rename" ? "Item" : editor.charAt(0).toUpperCase() + editor.slice(1)} name`}
      >
        <Input
          autoFocus
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Control>
      {editor === "field" && (
        <>
          <Control label="Field type">
            <select
              className={selectClass}
              aria-label="Field type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {[
                "Text",
                "Long text",
                "Number",
                "Integer",
                "Date",
                "Date time",
                "Checkbox",
                "Select",
                "Email",
                "URL",
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Control>
          <Control label="Default value">
            <Input value={value} onChange={(e) => setValue(e.target.value)} />
          </Control>
          {type === "Select" && (
            <Control label="Select options (comma separated)">
              <Input
                required
                value={options}
                onChange={(e) => setOptions(e.target.value)}
              />
            </Control>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />
            Required field
          </label>
        </>
      )}
      {editor === "relationship" && (
        <>
          <Control label="Target module">
            <select
              className={selectClass}
              aria-label="Target module"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {design.modules
                .filter((m) => m.id !== selectedModule?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Control>
          <Control label="Cardinality">
            <select
              className={selectClass}
              aria-label="Cardinality"
              value={cardinality}
              onChange={(e) => setCardinality(e.target.value)}
            >
              {["One-to-one", "One-to-many", "Many-to-many"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Control>
          {design.modules.find((m) => m.id === target)?.department !==
            selectedModule?.department && (
            <p
              role="alert"
              className="text-sm text-amber-700 dark:text-amber-400"
            >
              Cross-department relationship: review access for both departments.
              This is a sample connection.
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">
          {editor === "rename"
            ? "Save name"
            : editingRelationship
              ? "Save relationship"
              : `Create ${editor}`}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditor("")}>
          Cancel
        </Button>
      </div>
    </form>
  );
  return (
    <div className="space-y-3 xl:min-h-0 xl:flex-1">
      <nav
        aria-label="Designer panes"
        className="flex gap-1 rounded-lg border p-1 xl:hidden"
      >
        {["Structure", "Canvas", "Inspector"].map((tab) => (
          <Button
            key={tab}
            className="flex-1"
            variant={pane === tab ? "secondary" : "ghost"}
            aria-pressed={pane === tab}
            onClick={() => setPane(tab)}
          >
            {tab}
          </Button>
        ))}
      </nav>
      <div className="sandbox-ui border-border bg-card grid overflow-hidden rounded-xl border [--canvas-grid-major:var(--input)] [--canvas-grid:var(--border)] xl:h-full xl:grid-cols-[260px_minmax(0,1fr)_280px]">
        <aside
          aria-label="Organization structure"
          className={`border-border min-w-0 p-3 xl:block xl:min-h-0 xl:overflow-y-auto xl:border-r [&_section]:w-full [&_section]:min-w-0 ${pane === "Structure" ? "block" : "hidden"}`}
        >
          <SandboxInspector
            mode="outline"
            state={projected}
            onSelect={selectItem}
            onEdit={(id) => {
              selectItem(id);
              const relationship = design.relationships.find(
                (item) => item.id === id,
              );
              if (relationship) {
                open("relationship");
                setEditingRelationship(id);
                setName(relationship.name);
                setTarget(relationship.target);
                setCardinality(relationship.cardinality);
              } else setEditor("");
            }}
            onRenameDepartment={renameDepartment}
            onRenameModule={renameModule}
            onUpdateField={(id, patch) =>
              change((previous) => updateProjectedField(previous, id, patch))
            }
            onUpdateLinkLabel={(id, label) =>
              change((previous) => ({
                ...previous,
                relationships: previous.relationships.map((item) =>
                  item.id === id ? { ...item, name: label } : item,
                ),
              }))
            }
            onDeleteSelected={setDeleteTarget}
            onAddDepartment={() => open("department")}
            onAddModule={(id) => {
              setSelected(id);
              open("module");
            }}
            onAddField={(id, fieldType) => {
              setSelected(id);
              open("field");
              setType(sampleTypes[fieldType]);
            }}
            onMoveModule={moveModule}
            onAddRelationship={() => {
              setSelected(selectedModule?.id ?? design.modules[0]?.id ?? "");
              open("relationship");
              setTarget(
                design.modules.find(
                  (item) =>
                    item.id !== (selectedModule?.id ?? design.modules[0]?.id),
                )?.id ?? "",
              );
            }}
          />
        </aside>
        <div
          className={`border-border min-h-0 min-w-0 xl:flex xl:flex-col xl:border-r ${pane === "Canvas" ? "block" : "hidden"}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-muted-foreground text-xs">DESIGN CANVAS</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Zoom out"
                onClick={() => graphRef.current?.zoomOut()}
              >
                −
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Zoom in"
                onClick={() => graphRef.current?.zoomIn()}
              >
                +
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => graphRef.current?.fit()}
              >
                Fit canvas
              </Button>
            </div>
          </div>
          <div
            ref={canvasFrameRef}
            className="h-[420px] overflow-hidden xl:h-auto xl:min-h-0 xl:flex-1"
            aria-label="Module design canvas"
          >
            <SandboxCanvas
              state={projected}
              layout={design.layout ?? compactDefaultLayout}
              graphRef={graphRef}
              onSelect={(id) => setSelected(id ?? "")}
              onRenameDepartment={renameDepartment}
              onRenameModule={renameModule}
              onUpdateField={(id, patch) =>
                change((previous) => updateProjectedField(previous, id, patch))
              }
              onDrop={addFromCanvas}
              onConnect={connectModules}
              onMove={(id, parentId) => {
                if (parentId)
                  pendingMove.current = { id, department: parentId };
              }}
              onLayoutChange={(layout) => {
                const moved = pendingMove.current;
                pendingMove.current = null;
                change((previous) => ({
                  ...previous,
                  layout,
                  modules: moved
                    ? previous.modules.map((item) =>
                        item.id === moved.id
                          ? { ...item, department: moved.department }
                          : item,
                      )
                    : previous.modules,
                }));
              }}
            />
          </div>
        </div>
        <aside
          aria-label="Design inspector"
          className={`space-y-5 p-5 xl:block xl:min-h-0 xl:overflow-y-auto ${pane === "Inspector" ? "block" : "hidden"}`}
        >
          <Button
            className="xl:hidden"
            variant="ghost"
            size="sm"
            onClick={() => setPane("Structure")}
          >
            Back to structure
          </Button>
          <div>
            <p className="text-muted-foreground text-xs">
              {selectedModule ? "MODULE" : "DEPARTMENT"}
            </p>
            <h2 className="mt-1 text-lg font-semibold">
              {selectedModule?.name ??
                department?.name ??
                "Start your structure"}
            </h2>
          </div>
          {editor && editor !== "relationship" ? (
            editorForm
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => open("rename")}>
                  Rename {selectedModule ? "module" : "department"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (selectedModule)
                      change({
                        ...design,
                        modules: design.modules.map((m) =>
                          m.id === selectedModule.id
                            ? { ...m, closed: !m.closed }
                            : m,
                        ),
                      });
                    else if (department)
                      change({
                        ...design,
                        departments: design.departments.map((d) =>
                          d.id === department.id
                            ? { ...d, closed: !d.closed }
                            : d,
                        ),
                      });
                  }}
                >
                  {(selectedModule ?? department)?.closed ? "Reopen" : "Close"}{" "}
                  {selectedModule ? "module" : "department"}
                </Button>
                <Button variant="outline" onClick={() => open("module")}>
                  Add module
                </Button>
              </div>
              {selectedModule && (
                <>
                  <div className="border-border space-y-2 border-t pt-4">
                    <h3 className="text-xs font-semibold uppercase">
                      Module order
                    </h3>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={design.modules.indexOf(selectedModule) === 0}
                        onClick={() =>
                          change({
                            ...design,
                            modules: reorder(
                              design.modules,
                              design.modules.indexOf(selectedModule),
                              -1,
                            ),
                          })
                        }
                      >
                        Earlier
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          design.modules.indexOf(selectedModule) ===
                          design.modules.length - 1
                        }
                        onClick={() =>
                          change({
                            ...design,
                            modules: reorder(
                              design.modules,
                              design.modules.indexOf(selectedModule),
                              1,
                            ),
                          })
                        }
                      >
                        Later
                      </Button>
                    </div>
                  </div>
                  <div className="border-border space-y-3 border-t pt-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold">Fields</h3>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => open("field")}
                      >
                        <Plus />
                        Add field
                      </Button>
                    </div>
                    {selectedModule.fields.map((f, i) => (
                      <details
                        open={selectedField?.field.id === f.id || undefined}
                        key={f.id}
                        className="border-border rounded-md border p-3"
                      >
                        <summary className="cursor-pointer text-sm">
                          {f.name}
                          <span className="text-muted-foreground ml-2 text-xs">
                            {f.closed ? "Closed" : f.type}
                          </span>
                        </summary>
                        <div className="mt-3 space-y-3">
                          <Control label={`${f.name} field type`}>
                            <select
                              aria-label={`${f.name} field type`}
                              className={selectClass}
                              value={f.type}
                              onChange={(event) =>
                                updateField(f.id, { type: event.target.value })
                              }
                            >
                              {[
                                "Text",
                                "Long text",
                                "Integer",
                                "Number",
                                "Date",
                                "Date time",
                                "Checkbox",
                                "Select",
                                "Email",
                                "URL",
                              ].map((fieldType) => (
                                <option key={fieldType}>{fieldType}</option>
                              ))}
                            </select>
                          </Control>
                          <Control label={`${f.name} description`}>
                            <Input
                              value={f.description ?? ""}
                              onChange={(event) =>
                                updateField(f.id, {
                                  description: event.target.value,
                                })
                              }
                            />
                          </Control>
                          <Control label={`${f.name} default value`}>
                            <Input
                              value={f.value}
                              onChange={(e) =>
                                updateField(f.id, { value: e.target.value })
                              }
                            />
                          </Control>
                          {f.type === "Select" && (
                            <Control label={`${f.name} options`}>
                              <Input
                                value={f.options}
                                onChange={(e) =>
                                  updateField(f.id, { options: e.target.value })
                                }
                              />
                            </Control>
                          )}
                          <label className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={f.required}
                              onChange={(e) =>
                                updateField(f.id, {
                                  required: e.target.checked,
                                })
                              }
                            />
                            Required
                          </label>
                          <div className="flex flex-wrap gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${f.name} up`}
                              disabled={i === 0}
                              onClick={() =>
                                change({
                                  ...design,
                                  modules: design.modules.map((m) =>
                                    m.id === selectedModule.id
                                      ? {
                                          ...m,
                                          fields: reorder(m.fields, i, -1),
                                        }
                                      : m,
                                  ),
                                })
                              }
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={`Move ${f.name} down`}
                              disabled={i === selectedModule.fields.length - 1}
                              onClick={() =>
                                change({
                                  ...design,
                                  modules: design.modules.map((m) =>
                                    m.id === selectedModule.id
                                      ? {
                                          ...m,
                                          fields: reorder(m.fields, i, 1),
                                        }
                                      : m,
                                  ),
                                })
                              }
                            >
                              <ArrowDown />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                updateField(f.id, { closed: !f.closed })
                              }
                            >
                              {f.closed ? "Reopen" : "Close"} field
                            </Button>
                          </div>
                        </div>
                      </details>
                    ))}
                  </div>
                  <div className="border-border space-y-3 border-t pt-4">
                    <h3 className="text-sm font-semibold">Relationships</h3>
                    <Button
                      variant="outline"
                      onClick={() => {
                        open("relationship");
                        setTarget(
                          design.modules.find((m) => m.id !== selectedModule.id)
                            ?.id ?? "",
                        );
                      }}
                      disabled={design.modules.length < 2}
                    >
                      <Link2 />
                      Connect modules
                    </Button>
                    {design.relationships
                      .filter((r) => r.source === selectedModule.id)
                      .map((r) => (
                        <div
                          key={r.id}
                          className="border-border rounded-md border p-3 text-xs"
                        >
                          <strong>{r.name}</strong>
                          <p className="text-muted-foreground my-2">
                            {r.cardinality} →{" "}
                            {
                              design.modules.find((m) => m.id === r.target)
                                ?.name
                            }
                          </p>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              change({
                                ...design,
                                relationships: design.relationships.filter(
                                  (x) => x.id !== r.id,
                                ),
                              })
                            }
                          >
                            Delete relationship
                          </Button>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </>
          )}
          <p className="sr-only">{counts(design)}</p>
        </aside>
      </div>
      <Dialog
        open={editor === "relationship"}
        onOpenChange={(open) => {
          if (!open) setEditor("");
        }}
      >
        <DialogContent>
          <DialogTitle>
            {editingRelationship ? "Relationship settings" : "Connect modules"}
          </DialogTitle>
          <p className="text-muted-foreground my-3 text-sm">
            Source: {selectedModule?.name}
          </p>
          {editorForm}
        </DialogContent>
      </Dialog>
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Delete sample {deleteTarget?.kind}</DialogTitle>
          <p className="text-muted-foreground my-4 text-sm">
            This removes the item and its contained fields or connections from
            the sample design. Undo restores it.
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" onClick={removeSelected}>
              Confirm delete
            </Button>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
