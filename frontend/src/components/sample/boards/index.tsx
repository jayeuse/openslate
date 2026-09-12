"use client";
import { useState } from "react";
import { initialRoles, departments } from "../access/model";
import { Plus, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useSampleState } from "@/components/sample/sample-state";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "@/components/sample/sample-data";
import {
  WidgetSurface,
  newWidget,
  type SampleWidget,
} from "../openview/widgets";
import { BoardAnnouncements, BoardCalendar } from "./board-editors";

export type SampleBoard = {
  id: string;
  name: string;
  department: string;
  roles: string[];
  permission: string;
  widgets: SampleWidget[];
};
export const initialBoards: SampleBoard[] = [
  {
    id: "sample-board-organization",
    name: "Organization board",
    department: "Organization",
    roles: initialRoles.map((role) => role.name),
    permission: "Members can view",
    widgets: [
      {
        id: "sample-board-summary",
        type: "Summary",
        size: "Half",
        permission: "Everyone",
        refresh: "Manual",
        pinned: true,
      },
      {
        id: "sample-board-workload",
        type: "Workload",
        size: "Half",
        permission: "Everyone",
        refresh: "Manual",
        pinned: false,
      },
    ],
  },
];
export default function SampleBoards() {
  const [section, setSection] = useSampleState("boards-section", "Overview");
  const [boards, setBoards] = useSampleState<SampleBoard[]>(
    "boards-list",
    initialBoards,
  );
  const [selected, setSelected] = useSampleState(
    "boards-selected",
    "sample-board-organization",
  );
  const [roles] = useSampleState("access-roles", initialRoles);
  const [records] = useSampleState<SampleRecord[]>("records", INITIAL_RECORDS);
  const [pinnedRecords] = useSampleState<string[]>("platformBoardRecords", []);
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("Operations");
  const [widgetType, setWidgetType] = useState("Summary");
  const board =
    boards.find((item) => item.id === selected) ??
    boards[0] ??
    initialBoards[0];
  function update(change: Partial<SampleBoard>) {
    setBoards(
      (boards.length ? boards : initialBoards).map((item) =>
        item.id === board.id ? { ...item, ...change } : item,
      ),
    );
  }
  return (
    <div className="min-w-0 space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Boards</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {board.department} · {records.length} service requests
          </p>
        </div>
        <Button
          variant="outline"
          aria-label="Create department board"
          onClick={() => setCreating(true)}
        >
          <Plus />
          <span className="hidden sm:inline">Create department board</span>
          <span className="sm:hidden">New board</span>
        </Button>
      </header>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <label className="min-w-0 flex-1 space-y-2 text-xs font-medium sm:max-w-72">
          Current board
          <Select value={board.id} onValueChange={setSelected}>
            {(boards.length ? boards : initialBoards).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>
        <Button
          variant="ghost"
          aria-label="Board settings"
          onClick={() => setSettings(!settings)}
        >
          <Settings2 />
          <span className="hidden sm:inline">Board settings</span>
        </Button>
      </div>
      {creating && (
        <form
          className="bg-card grid gap-4 rounded-xl border p-5 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            const id = `sample-board-${crypto.randomUUID()}`;
            setBoards([
              ...boards,
              {
                id,
                name: name.trim(),
                department,
                roles: initialRoles.map((role) => role.name),
                permission: "Members can view",
                widgets: [],
              },
            ]);
            setSelected(id);
            setCreating(false);
            setName("");
            setSection("Overview");
          }}
        >
          <label className="space-y-2 text-sm">
            Board name
            <Input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            Department
            <Select value={department} onValueChange={setDepartment}>
              {departments.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </label>
          <div className="flex gap-2 sm:col-span-2">
            <Button>Create board</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {settings && (
        <section
          aria-label="Board settings"
          className="bg-card grid gap-5 rounded-xl border p-5 sm:grid-cols-2"
        >
          <fieldset>
            <legend className="mb-3 text-sm font-medium">
              Visible to sample roles
            </legend>
            <div className="flex flex-wrap gap-4">
              {roles
                .map((role) => role.name)
                .map((role) => (
                  <label key={role} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={board.roles.includes(role)}
                      onChange={(event) =>
                        update({
                          roles: event.target.checked
                            ? [...board.roles, role]
                            : board.roles.filter((item) => item !== role),
                        })
                      }
                    />
                    {role}
                  </label>
                ))}
            </div>
          </fieldset>
          <label className="space-y-2 text-sm">
            Board permission
            <Select
              value={board.permission}
              onValueChange={(permission) => update({ permission })}
            >
              {[
                "Members can view",
                "Members can edit",
                "Administrators only",
              ].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          </label>
          <p className="text-muted-foreground text-xs sm:col-span-2">
            Sample access preview:{" "}
            {board.roles.length ? board.roles.join(", ") : "No roles"} ·{" "}
            {board.permission}. Live permissions remain unchanged.
          </p>
          <Button
            variant="outline"
            className="w-fit"
            onClick={() => setSettings(false)}
          >
            Done
          </Button>
        </section>
      )}
      <nav
        aria-label="Board sections"
        className="flex gap-5 overflow-x-auto border-b"
      >
        {["Overview", "Calendar", "Announcements"].map((item) => (
          <button
            key={item}
            className={`shrink-0 border-b-2 px-1 py-3 text-sm font-medium ${section === item ? "border-foreground" : "text-muted-foreground hover:text-foreground border-transparent"}`}
            aria-current={section === item ? "page" : undefined}
            onClick={() => setSection(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {section === "Calendar" ? (
        <BoardCalendar records={records} />
      ) : section === "Announcements" ? (
        <BoardAnnouncements />
      ) : (
        <div className="space-y-6">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">
                {board.name}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {records.length} service requests ·{" "}
                {new Set(records.map((record) => record.assignee)).size} team
                members
              </p>
            </div>
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add widget
            </Button>
          </header>
          {adding && (
            <form
              className="bg-card flex flex-wrap items-end gap-3 rounded-xl border p-5"
              onSubmit={(event) => {
                event.preventDefault();
                update({ widgets: [...board.widgets, newWidget(widgetType)] });
                setAdding(false);
              }}
            >
              <label className="min-w-52 space-y-2 text-sm">
                Widget type
                <Select
                  aria-label="Widget type"
                  value={widgetType}
                  onValueChange={setWidgetType}
                >
                  {["Summary", "Workload", "OpenView"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </label>
              {widgetType === "OpenView" && (
                <p className="text-muted-foreground max-w-sm pb-2 text-xs">
                  Embeds Service requests from the shared sample workspace.
                  Layout & access includes resize and refresh settings.
                </p>
              )}
              <Button>Add to board</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
            </form>
          )}
          <WidgetSurface
            board
            widgets={board.widgets}
            onChange={(widgets) => update({ widgets })}
            records={records}
          />
          {board.id === "sample-board-organization" &&
            pinnedRecords.length > 0 && (
              <section className="bg-card rounded-xl border p-5">
                <h3 className="font-medium">Records added to this board</h3>
                <div className="mt-3 divide-y">
                  {records
                    .filter((record) => pinnedRecords.includes(record.id))
                    .map((record) => (
                      <a
                        className="block py-3 text-sm hover:underline"
                        key={record.id}
                        href={`/openview?record=${encodeURIComponent(record.id)}`}
                      >
                        {record.title}
                        <span className="text-muted-foreground ml-3">
                          {record.status}
                        </span>
                      </a>
                    ))}
                </div>
              </section>
            )}
        </div>
      )}
    </div>
  );
}
