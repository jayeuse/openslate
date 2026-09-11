"use client";

import { Suspense, useState } from "react";
import { z } from "zod";
import { useSearchParams } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { initialRoles, initialPeople } from "../access/model";
import {
  CalendarDays,
  Plus,
  Columns3,
  GalleryHorizontal,
  GanttChart,
  LayoutGrid,
  Search,
  Table2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useSampleState } from "@/components/sample/sample-state";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "@/components/sample/sample-data";
import SampleAnalytics from "./analytics";

type ViewConfig = {
  type: string;
  search: string;
  status: string;
  sort: string;
  group: string;
};
type SavedView = ViewConfig & { id: string; name: string; audience: string };
const savedViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  audience: z.string(),
  type: z.string(),
  search: z.string(),
  status: z.string(),
  sort: z.string(),
  group: z.string(),
});
const initial: ViewConfig = {
  type: "Table",
  search: "",
  status: "All statuses",
  sort: "title",
  group: "None",
};
const modes = [
  { name: "Table", icon: Table2 },
  { name: "Grid", icon: LayoutGrid },
  { name: "Calendar", icon: CalendarDays },
  { name: "Kanban", icon: Columns3 },
  { name: "Timeline", icon: GanttChart },
  { name: "Gallery", icon: GalleryHorizontal },
];

export default function SampleOpenView() {
  return (
    <Suspense fallback={<p>Opening views…</p>}>
      <OpenViewContent />
    </Suspense>
  );
}
function OpenViewContent() {
  const query = useSearchParams();
  const recordQuery = query.get("record");
  const [storedSection, setStoredSection] = useSampleState(
    "views-section",
    "Views",
  );
  const [records, setRecords] = useSampleState<SampleRecord[]>(
    "records",
    INITIAL_RECORDS,
  );
  const [roles] = useSampleState("access-roles", initialRoles);
  const [people] = useSampleState("access-people", initialPeople);
  const [storedConfig, setStoredConfig] = useSampleState<ViewConfig>(
    "views-current",
    initial,
  );
  const [storedSaved, setSaved] = useSampleState<SavedView[]>(
    "views-saved",
    [],
  );
  const saved = storedSaved.flatMap((value) => {
    const result = savedViewSchema.safeParse(value);
    return result.success ? [result.data] : [];
  });
  const [defaultId, setDefaultId] = useSampleState("views-default", "");
  const [storedView, setStoredView] = useSampleState("views-selected", "");
  const [selectedView, setCurrentView] = useState(defaultId || storedView);
  const [entryDefault, setEntryDefault] = useState<ViewConfig | null>(
    () => saved.find((view) => view.id === defaultId) ?? null,
  );
  const config = entryDefault ?? storedConfig;
  const setConfig = (next: ViewConfig) => {
    setEntryDefault(null);
    setStoredConfig(next);
  };
  const setSelectedView = (id: string) => {
    setCurrentView(id);
    setStoredView(id);
  };
  const [navigation, setNavigation] = useState({
    query: recordQuery,
    section: recordQuery ? "Views" : storedSection,
    selected: recordQuery,
  });
  const section =
    navigation.query === recordQuery
      ? navigation.section
      : recordQuery
        ? "Views"
        : storedSection;
  const selected =
    navigation.query === recordQuery ? navigation.selected : recordQuery;
  const setSection = (next: string) => {
    setNavigation({ query: recordQuery, section: next, selected });
    setStoredSection(next);
  };
  const setSelected = (id: string | null) =>
    setNavigation({ query: recordQuery, section, selected: id });
  const [newRecord, setNewRecord] = useState(false);
  const [draft, setDraft] = useState({
    title: "",
    customer: "",
    status: "Open",
    assignee: people.find((person) => person.active)?.name ?? "Unassigned",
    dueDate: "",
  });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [audience, setAudience] = useState("Only me");
  const [message, setMessage] = useState("");
  const [sharing, setSharing] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  function change(partial: Partial<ViewConfig>) {
    setConfig({ ...config, ...partial });
  }
  const visible = records
    .filter(
      (record) =>
        `${record.title} ${record.customer}`
          .toLowerCase()
          .includes(config.search.toLowerCase()) &&
        (config.status === "All statuses" || record.status === config.status),
    )
    .sort((a, b) =>
      String(a[config.sort as keyof SampleRecord] ?? "").localeCompare(
        String(b[config.sort as keyof SampleRecord] ?? ""),
      ),
    );
  const groups =
    config.group === "None"
      ? ["All requests"]
      : [
          ...new Set(
            visible.map((record) =>
              String(record[config.group as keyof SampleRecord]),
            ),
          ),
        ];
  const inspected = records.find((record) => record.id === selected);
  const activeSaved = saved.find((view) => view.id === selectedView);

  return (
    <div className="min-w-0 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {section === "Views" ? "Service requests" : section}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {section === "Views"
              ? `${visible.length} matching ${visible.length === 1 ? "record" : "records"}`
              : "Service requests · Sample workspace"}
          </p>
        </div>
        {section === "Views" && (
          <Button onClick={() => setNewRecord(true)}>
            <Plus aria-hidden="true" />
            New record
          </Button>
        )}
      </header>
      <Dialog open={newRecord} onOpenChange={setNewRecord}>
        <DialogContent className="max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none">
          <DialogTitle>New service request</DialogTitle>
          <DialogDescription>
            Create a synthetic request in this sample workspace.
          </DialogDescription>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !draft.title.trim() ||
                !draft.customer.trim() ||
                !draft.dueDate
              )
                return;
              const record = {
                ...draft,
                title: draft.title.trim(),
                customer: draft.customer.trim(),
                id: `sample-sr-${crypto.randomUUID()}`,
              };
              setRecords((previous) => [...previous, record]);
              setConfig({ ...config, search: "", status: "All statuses" });
              setSelected(record.id);
              setNewRecord(false);
              setDraft({
                title: "",
                customer: "",
                status: "Open",
                assignee: people[0]?.name ?? "Unassigned",
                dueDate: "",
              });
            }}
          >
            <label className="block space-y-2 text-sm">
              Request title
              <Input
                required
                maxLength={120}
                value={draft.title}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </label>
            <label className="block space-y-2 text-sm">
              Request customer
              <Input
                required
                maxLength={120}
                value={draft.customer}
                onChange={(event) =>
                  setDraft({ ...draft, customer: event.target.value })
                }
              />
            </label>
            <label className="block space-y-2 text-sm">
              Request status
              <Select
                value={draft.status}
                onValueChange={(status) => setDraft({ ...draft, status })}
              >
                {[
                  "Open",
                  "In progress",
                  "Scheduled",
                  "On hold",
                  "Completed",
                ].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </Select>
            </label>
            <label className="block space-y-2 text-sm">
              Request assignee
              <Select
                value={draft.assignee}
                onValueChange={(assignee) => setDraft({ ...draft, assignee })}
              >
                {people
                  .filter((person) => person.active)
                  .map((person) => (
                    <option key={person.id}>{person.name}</option>
                  ))}
                <option>Unassigned</option>
              </Select>
            </label>
            <label className="block space-y-2 text-sm">
              Request due date
              <Input
                required
                type="date"
                value={draft.dueDate}
                onChange={(event) =>
                  setDraft({ ...draft, dueDate: event.target.value })
                }
              />
            </label>
            <div className="flex gap-2">
              <Button>Create sample record</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setNewRecord(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <nav
        aria-label="OpenView sections"
        className="flex gap-5 overflow-x-auto border-b"
      >
        {["Views", "Dashboards", "Charts", "Reports"].map((item) => (
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
      {section !== "Views" ? (
        <SampleAnalytics section={section} records={records} />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <label className="block min-w-0 flex-1 text-xs font-medium">
              <span className="sr-only">
                <Search className="size-3" />
                Search requests
              </span>
              <Input
                aria-label="Search requests"
                placeholder="Search title or customer…"
                value={config.search}
                onChange={(event) => change({ search: event.target.value })}
              />
            </label>
            <Button
              className="min-h-10 md:hidden"
              variant="outline"
              aria-expanded={optionsOpen}
              onClick={() => setOptionsOpen(!optionsOpen)}
            >
              View options
            </Button>
          </div>
          <div
            className={`${optionsOpen ? "block" : "hidden"} space-y-4 md:block`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!activeSaved}
                  onClick={() => setSharing(!sharing)}
                >
                  Share view
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(true);
                    setName(activeSaved?.name ?? "");
                  }}
                >
                  Save view
                </Button>
              </div>
              <div
                className="order-first flex flex-wrap items-center gap-1"
                aria-label="View types"
              >
                {modes.map(({ name: mode, icon: Icon }) => (
                  <Button
                    key={mode}
                    variant={config.type === mode ? "secondary" : "ghost"}
                    aria-pressed={config.type === mode}
                    onClick={() => change({ type: mode })}
                  >
                    <Icon />
                    {mode}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs font-medium">
                Add filter
                <Select
                  aria-label="Status filter"
                  value={config.status}
                  onValueChange={(status) => change({ status })}
                >
                  {[
                    "All statuses",
                    ...new Set(records.map((record) => record.status)),
                  ].map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Sort by
                <Select
                  aria-label="Sort by"
                  value={config.sort}
                  onValueChange={(sort) => change({ sort })}
                >
                  <option value="title">Request</option>
                  <option value="dueDate">Due date</option>
                  <option value="customer">Customer</option>
                  <option value="status">Status</option>
                </Select>
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Group by
                <Select
                  aria-label="Group by"
                  value={config.group}
                  onValueChange={(group) => change({ group })}
                >
                  <option>None</option>
                  <option value="status">Status</option>
                  <option value="assignee">Assignee</option>
                  <option value="customer">Customer</option>
                </Select>
              </label>
            </div>
          </div>
          {(config.status !== "All statuses" || config.search) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => change({ status: "All statuses", search: "" })}
            >
              <X />
              Remove filters
            </Button>
          )}
          {saved.length > 0 && (
            <div
              className={`${optionsOpen ? "flex" : "hidden"} flex-wrap items-end gap-3 md:flex`}
            >
              <label className="min-w-48 space-y-1 text-xs font-medium">
                Saved view
                <Select
                  aria-label="Saved view"
                  value={selectedView}
                  onValueChange={(id) => {
                    const view = saved.find((v) => v.id === id);
                    if (view) {
                      setSelectedView(id);
                      setConfig(view);
                      setAudience(view.audience);
                    }
                  }}
                >
                  <option value="">Choose a saved view</option>
                  {saved.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                variant="ghost"
                disabled={!activeSaved}
                onClick={() => {
                  setDefaultId(selectedView);
                  setMessage(
                    `${activeSaved?.name} is the default sample view for Service requests.`,
                  );
                }}
              >
                Set as module default
              </Button>
              {defaultId && (
                <span className="text-muted-foreground pb-2 text-xs">
                  Default: {saved.find((view) => view.id === defaultId)?.name}
                </span>
              )}
            </div>
          )}
          {editing && (
            <form
              className="bg-muted/40 flex flex-wrap items-end gap-3 rounded-xl border p-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                const id = `sample-view-${crypto.randomUUID()}`;
                setSaved([
                  ...saved,
                  { ...config, id, name: name.trim(), audience },
                ]);
                setSelectedView(id);
                setEditing(false);
                setMessage(`“${name.trim()}” saved in this sample workspace.`);
              }}
            >
              <label className="flex-1 space-y-2 text-sm">
                View name
                <Input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Button type="submit">Save current view</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </form>
          )}
          {sharing && activeSaved && (
            <form
              className="flex flex-wrap items-end gap-3 rounded-xl border p-5"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(
                  saved.map((view) =>
                    view.id === selectedView ? { ...view, audience } : view,
                  ),
                );
                setSharing(false);
                setMessage(
                  `Sample view shared with ${audience}. No invitation was sent.`,
                );
              }}
            >
              <label className="min-w-52 space-y-2 text-sm">
                Share with user or role
                <Select value={audience} onValueChange={setAudience}>
                  {[
                    "Only me",
                    ...roles.map((role) => `Role: ${role.name}`),
                    ...people
                      .filter((person) => person.active)
                      .map((person) => `User: ${person.name}`),
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </label>
              <Button>Save sharing</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSharing(false)}
              >
                Cancel
              </Button>
            </form>
          )}
          {message && (
            <p role="status" className="text-muted-foreground text-sm">
              {message}
            </p>
          )}
          <div
            className={`grid min-w-0 gap-6 ${inspected ? "xl:grid-cols-[minmax(0,1fr)_300px]" : ""}`}
          >
            <div
              className={`min-w-0 space-y-5 ${inspected ? "hidden xl:block" : ""}`}
            >
              {visible.length === 0 ? (
                <div className="rounded-xl border border-dashed p-12 text-center">
                  <p className="font-medium">
                    No requests match these filters.
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() =>
                      change({ search: "", status: "All statuses" })
                    }
                  >
                    Clear filters
                  </Button>
                </div>
              ) : (
                groups.map((group) => (
                  <section key={group}>
                    {config.group !== "None" && (
                      <h3 className="mb-3 text-sm font-semibold">{group}</h3>
                    )}
                    <RecordView
                      records={
                        config.group === "None"
                          ? visible
                          : visible.filter(
                              (record) =>
                                String(
                                  record[config.group as keyof SampleRecord],
                                ) === group,
                            )
                      }
                      type={config.type}
                      onSelect={setSelected}
                    />
                  </section>
                ))
              )}
            </div>
            {inspected && (
              <aside
                aria-label="Request detail"
                className="bg-card self-start rounded-xl border p-6 xl:sticky xl:top-6"
              >
                <header className="flex items-start justify-between gap-4">
                  <h2 className="text-xl font-semibold tracking-tight">
                    {inspected.title}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close request detail"
                    onClick={() => setSelected(null)}
                  >
                    <X />
                  </Button>
                </header>
                <p className="text-muted-foreground mt-2 text-xs break-all">
                  {inspected.id}
                </p>
                <dl className="mt-6 space-y-5 text-sm">
                  {[
                    ["Status", inspected.status],
                    ["Customer", inspected.customer],
                    ["Assignee", inspected.assignee],
                    ["Due date", inspected.dueDate],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground mb-1 text-xs">
                        {label}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-muted-foreground mt-6 border-t pt-5 text-xs">
                  Synthetic service request shared across the sample workspace.
                </p>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RecordView({
  records,
  type,
  onSelect,
}: {
  records: SampleRecord[];
  type: string;
  onSelect: (id: string) => void;
}) {
  if (type === "Table")
    return (
      <>
        <div
          className="divide-y rounded-xl border md:hidden"
          aria-label="Service request list"
        >
          {records.map((record) => (
            <button
              key={record.id}
              onClick={() => onSelect(record.id)}
              className="hover:bg-muted/30 block w-full p-4 text-left"
            >
              <span className="block text-sm font-medium">{record.title}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {record.customer}
              </span>
              <span className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="bg-muted rounded px-2 py-1">
                  {record.status}
                </span>
                <span>{record.assignee}</span>
              </span>
              <span className="text-muted-foreground mt-2 block text-xs">
                Due {record.dueDate}
              </span>
            </button>
          ))}
        </div>
        <div className="hidden overflow-x-auto rounded-xl border md:block">
          <table className="w-full min-w-[650px] text-left text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs">
              <tr>
                {["Request", "Customer", "Status", "Assignee", "Due date"].map(
                  (title) => (
                    <th key={title} className="px-4 py-3 font-medium">
                      {title}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {records.map((record) => (
                <tr key={record.id} className="hover:bg-muted/40">
                  <td className="px-4 py-4">
                    <button
                      className="text-left font-medium hover:underline"
                      onClick={() => onSelect(record.id)}
                    >
                      {record.title}
                    </button>
                  </td>
                  <td className="text-muted-foreground px-4 py-4">
                    {record.customer}
                  </td>
                  <td className="px-4 py-4">
                    <span className="bg-muted rounded px-2 py-1 text-xs whitespace-nowrap">
                      {record.status}
                    </span>
                  </td>
                  <td className="px-4 py-4">{record.assignee}</td>
                  <td className="text-muted-foreground px-4 py-4 whitespace-nowrap">
                    {record.dueDate}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  if (type === "Kanban")
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {[...new Set(records.map((record) => record.status))].map((status) => (
          <div key={status} className="bg-muted/40 rounded-xl p-4">
            <h3 className="mb-4 flex justify-between text-sm font-medium">
              {status}
              <span className="text-muted-foreground">
                {records.filter((record) => record.status === status).length}
              </span>
            </h3>
            {records
              .filter((record) => record.status === status)
              .map((record) => (
                <button
                  key={record.id}
                  onClick={() => onSelect(record.id)}
                  className="bg-card hover:border-foreground/40 mb-3 block w-full rounded-lg border p-4 text-left text-sm"
                >
                  <strong className="font-medium">{record.title}</strong>
                  <span className="text-muted-foreground mt-3 block text-xs">
                    {record.assignee} · {record.dueDate}
                  </span>
                </button>
              ))}
          </div>
        ))}
      </div>
    );
  if (type === "Calendar")
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[...new Set(records.map((record) => record.dueDate))]
          .sort()
          .map((date) => (
            <section key={date} className="min-h-40 rounded-xl border p-4">
              <h3 className="mb-4 text-sm font-semibold">
                {date || "Unscheduled"}
              </h3>
              {records
                .filter((record) => record.dueDate === date)
                .map((record) => (
                  <button
                    key={record.id}
                    className="bg-muted mb-2 block w-full rounded p-3 text-left text-sm hover:underline"
                    onClick={() => onSelect(record.id)}
                  >
                    {record.title}
                  </button>
                ))}
            </section>
          ))}
      </div>
    );
  if (type === "Timeline")
    return (
      <ol className="border-border ml-3 border-l-2">
        {[...records]
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((record) => (
            <li key={record.id} className="relative pb-6 pl-6">
              <span className="bg-foreground absolute top-2 -left-[5px] size-2 rounded-full" />
              <p className="text-muted-foreground mb-2 text-xs">
                {record.dueDate}
              </p>
              <button
                onClick={() => onSelect(record.id)}
                className="bg-card hover:bg-muted w-full rounded-lg border p-4 text-left text-sm"
              >
                {record.title}
                <span className="text-muted-foreground mt-2 block text-xs">
                  {record.assignee} · {record.status}
                </span>
              </button>
            </li>
          ))}
      </ol>
    );
  return (
    <div
      className={`grid gap-4 ${type === "Gallery" ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2"}`}
    >
      {records.map((record, index) => (
        <button
          key={record.id}
          onClick={() => onSelect(record.id)}
          className="bg-card hover:border-foreground/40 overflow-hidden rounded-xl border text-left"
        >
          {type === "Gallery" && (
            <div
              className="bg-muted text-muted-foreground flex h-36 items-center justify-center text-4xl font-light"
              aria-hidden="true"
            >
              {String(index + 1).padStart(2, "0")}
            </div>
          )}
          <div className="p-5">
            <span className="text-muted-foreground text-xs">
              {record.status} / {record.dueDate}
            </span>
            <h3 className="mt-3 font-medium">{record.title}</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {record.customer}
            </p>
            <p className="mt-5 text-xs">{record.assignee}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
