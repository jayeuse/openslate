"use client";

import { AccessSearchToolbar } from "./access-search-toolbar";

import { useRef, useState } from "react";
import { Building2, Maximize, Minus, Plus, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { AccessController } from "../state/controller";
import type { InternalIdentity } from "../domain/policy";

type Props = { controller: AccessController };
const UNASSIGNED = "unassigned";

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function OrganizationChart({ controller }: Props) {
  const [query, setQuery] = useState("");
  const [sortOrder, setSortOrder] = useState<"name" | "members">("name");
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [showShared, setShowShared] = useState(false);
  const [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  const profile = useRef<HTMLElement>(null);
  const internal = controller.state.identities.filter(
    (person): person is InternalIdentity => person.kind === "internal",
  );
  const names = new Map(
    controller.departmentCatalog.map((item) => [item.id, item.name]),
  );
  const departmentIds = [
    ...new Set([
      ...names.keys(),
      ...internal.flatMap((person) => person.departmentIds),
    ]),
  ];
  const departments = departmentIds
    .map((id) => ({
      id,
      name: names.get(id) ?? "Unavailable department",
      people: internal.filter((person) => person.departmentIds.includes(id)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unassigned = internal.filter(
    (person) => person.departmentIds.length === 0,
  );
  const branches = unassigned.length
    ? [
        ...departments,
        { id: UNASSIGNED, name: "No department", people: unassigned },
      ]
    : departments;
  const term = query.trim().toLowerCase();
  const matchesPerson = (person: InternalIdentity) =>
    `${person.name} ${person.title} ${person.email}`
      .toLowerCase()
      .includes(term);
  const visible = branches
    .filter(
      (department) =>
        !term ||
        department.name.toLowerCase().includes(term) ||
        department.people.some(matchesPerson),
    )
    .sort((left, right) =>
      sortOrder === "members"
        ? right.people.length - left.people.length ||
          left.name.localeCompare(right.name)
        : left.name.localeCompare(right.name),
    );
  const active = visible.find((department) => department.id === departmentId);
  const members =
    active?.people.filter(
      (person) =>
        !term ||
        active.name.toLowerCase().includes(term) ||
        matchesPerson(person),
    ) ?? [];
  const selected = internal.find((person) => person.id === personId);
  const stageWidth = Math.max(560, visible.length * 208);
  const sharedCount = internal.filter(
    (person) => new Set(person.departmentIds).size > 1,
  ).length;

  function fitView() {
    if (!viewport.current) return;
    setZoom(
      Math.max(
        25,
        Math.min(
          100,
          Math.floor(((viewport.current.clientWidth - 32) / stageWidth) * 100),
        ),
      ),
    );
    viewport.current.scrollTo({ left: 0, top: 0 });
  }

  function showPerson(id: string) {
    setPersonId(id);
    // On narrow screens the profile follows the canvas; move it into view.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      profile.current?.scrollIntoView({ block: "start" });
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Explore a department, then select a person to see their profile.
        Connections show membership, not reporting lines.
      </p>
      <AccessSearchToolbar
        searchLabel="Search people or departments"
        placeholder="People or departments"
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setPersonId(null);
        }}
        sortLabel="Sort departments"
        sort={sortOrder}
        sortOptions={[
          { value: "name", label: "Department name" },
          { value: "members", label: "Most members" },
        ]}
        onSortChange={setSortOrder}
        activeFilterCount={showShared ? 1 : 0}
      >
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox
            checked={showShared}
            onCheckedChange={(checked) => setShowShared(checked === true)}
          />
          Shared memberships
        </label>{" "}
      </AccessSearchToolbar>
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="flex items-center justify-end border-b p-3">
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="outline" className="min-h-11" onClick={fitView}>
              <Maximize aria-hidden="true" /> Fit view
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Zoom out"
              disabled={zoom <= 25}
              onClick={() => setZoom((value) => Math.max(25, value - 10))}
            >
              <Minus aria-hidden="true" />
            </Button>
            <output
              aria-label="Graph zoom"
              className="min-w-12 text-center text-sm tabular-nums"
            >
              {zoom}%
            </output>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label="Zoom in"
              disabled={zoom >= 150}
              onClick={() => setZoom((value) => Math.min(150, value + 10))}
            >
              <Plus aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="min-w-0">
            <div
              ref={viewport}
              role="region"
              aria-label="Department membership graph"
              tabIndex={0}
              className="bg-background focus-visible:outline-ring max-h-[65dvh] min-h-80 overflow-auto p-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] lg:min-h-[32rem]"
            >
              {!internal.length ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
                  <Users
                    aria-hidden="true"
                    className="text-muted-foreground size-6"
                  />
                  <h3 className="font-medium">No internal people yet</h3>
                  <p className="text-muted-foreground max-w-sm text-sm">
                    Department memberships will appear here when internal people
                    are assigned to departments.
                  </p>
                </div>
              ) : visible.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
                  <h3 className="font-medium">
                    No matching people or departments
                  </h3>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setQuery("")}
                  >
                    Clear search
                  </Button>
                </div>
              ) : (
                <div
                  style={{ width: stageWidth, zoom: `${zoom}%` }}
                  className="mx-auto pb-4"
                >
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      className="h-auto min-h-16 gap-3 px-5 py-3"
                      onClick={() => {
                        setPersonId(null);
                        setDepartmentId(null);
                      }}
                    >
                      <Building2 aria-hidden="true" className="size-5" />
                      <span className="text-left">
                        <span className="block font-semibold">
                          Organization
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {internal.length} internal people ·{" "}
                          {departments.length} departments
                        </span>
                      </span>
                    </Button>
                  </div>
                  <div
                    aria-hidden="true"
                    className="bg-border mx-auto h-6 w-px"
                  />
                  <div className="flex items-start">
                    {visible.map((department, index) => (
                      <div
                        key={department.id}
                        className="relative min-w-0 flex-1 px-2 pt-6"
                      >
                        <div
                          aria-hidden="true"
                          className={cn(
                            "border-border absolute top-0 h-6 border-t",
                            index === 0 ? "left-1/2" : "left-0",
                            index === visible.length - 1
                              ? "right-1/2"
                              : "right-0",
                          )}
                        />
                        <div
                          aria-hidden="true"
                          className="bg-border absolute top-0 left-1/2 h-6 w-px"
                        />
                        <Button
                          variant="outline"
                          aria-label={`Explore ${department.name}`}
                          aria-pressed={departmentId === department.id}
                          className={cn(
                            "h-auto min-h-20 w-full flex-col items-start gap-1 px-3 py-3 text-left whitespace-normal",
                            departmentId === department.id &&
                              "bg-accent text-accent-foreground border-primary",
                          )}
                          onClick={() => {
                            setDepartmentId(department.id);
                            setPersonId(null);
                          }}
                        >
                          <span className="flex items-center gap-2">
                            <Building2
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                            <span className="break-words">
                              {department.name}
                            </span>
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {department.people.length}{" "}
                            {department.people.length === 1
                              ? "person"
                              : "people"}
                          </span>
                        </Button>
                      </div>
                    ))}
                  </div>
                  {active ? (
                    <section
                      aria-label={`${active.name} members`}
                      className="bg-card mx-auto mt-6 max-w-md overflow-hidden rounded-lg border"
                    >
                      <h3 className="border-b px-4 py-3 text-sm font-semibold">
                        {active.name} members · {members.length}
                      </h3>
                      {members.length ? (
                        <ul className="divide-y">
                          {members.map((person) => (
                            <li key={person.id}>
                              <button
                                type="button"
                                aria-label={`View ${person.name}`}
                                aria-pressed={selected?.id === person.id}
                                onClick={() => showPerson(person.id)}
                                className={cn(
                                  "hover:bg-muted focus-visible:outline-ring flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
                                  selected?.id === person.id && "bg-accent",
                                )}
                              >
                                <span
                                  aria-hidden="true"
                                  className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full text-xs font-medium"
                                >
                                  {initials(person.name)}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium break-words">
                                    {person.name}
                                  </span>
                                  <span className="text-muted-foreground block text-xs break-words">
                                    {person.title || "No title"}
                                  </span>
                                </span>
                                <span className="flex max-w-32 flex-wrap justify-end gap-1">
                                  {person.primaryDepartmentId === active.id && (
                                    <Badge variant="outline">Primary</Badge>
                                  )}
                                  {showShared &&
                                    person.departmentIds.length > 1 && (
                                      <Badge variant="secondary">
                                        {person.departmentIds.length}{" "}
                                        departments
                                      </Badge>
                                    )}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground p-4 text-sm">
                          No people assigned to this department.
                        </p>
                      )}
                    </section>
                  ) : (
                    <p className="text-muted-foreground mt-8 text-center text-sm">
                      Choose a department to view its members.
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 border-t px-4 py-3 text-xs">
              <span>Primary = main department</span>
              <span>
                {sharedCount}{" "}
                {sharedCount === 1 ? "person belongs" : "people belong"} to
                multiple departments
              </span>
              <span>Scroll to explore · use Fit view to recenter</span>
            </div>
          </div>
          <aside
            ref={profile}
            aria-label="Organization details"
            className="bg-muted/20 min-w-0 border-t p-5 lg:border-t-0 lg:border-l"
          >
            {selected ? (
              <div className="flex flex-col gap-5">
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    aria-label="Show organization profile"
                    onClick={() => setPersonId(null)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                <div>
                  <span
                    aria-hidden="true"
                    className="bg-muted mb-3 grid size-14 place-items-center rounded-full text-lg font-semibold"
                  >
                    {initials(selected.name)}
                  </span>
                  <h3 className="text-xl font-semibold break-words">
                    {selected.name}
                  </h3>
                  <p className="text-muted-foreground mt-1 text-sm break-words">
                    {selected.title || "No title"}
                  </p>
                  <p className="text-muted-foreground mt-2 text-sm break-all">
                    {selected.email}
                  </p>
                </div>
                <section className="border-t pt-4">
                  <h4 className="mb-3 text-sm font-semibold">
                    Department memberships
                  </h4>
                  {selected.departmentIds.length ? (
                    <ul className="space-y-3">
                      {selected.departmentIds.map((id) => (
                        <li
                          key={id}
                          className="flex items-start justify-between gap-2 text-sm"
                        >
                          <span className="min-w-0 break-words">
                            {names.get(id) ?? "Unavailable department"}
                          </span>
                          <Badge
                            variant={
                              selected.primaryDepartmentId === id
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {selected.primaryDepartmentId === id
                              ? "Primary"
                              : "Additional"}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No department assigned
                    </p>
                  )}
                </section>
                <p className="text-muted-foreground border-t pt-4 text-xs">
                  Department membership describes where this person belongs. It
                  does not show a reporting relationship.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                <div className="border-b pt-4 pb-6">
                  <span
                    aria-hidden="true"
                    className="bg-foreground text-background mb-5 grid size-14 place-items-center rounded-xl text-lg font-bold"
                  >
                    OS
                  </span>
                  <p className="text-sm font-medium">OpenSlate workspace</p>
                  <h3 className="mt-2 text-2xl font-semibold tracking-tight">
                    Your organization
                  </h3>
                  <p className="text-muted-foreground mt-3 text-sm">
                    The people and departments that make up your workspace.
                  </p>
                </div>
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt>People</dt>
                    <dd>{internal.length} internal people</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Departments</dt>
                    <dd>{departments.length}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>No department</dt>
                    <dd>{unassigned.length}</dd>
                  </div>
                </dl>
                <p className="text-muted-foreground border-t pt-4 text-sm">
                  Select a person in the graph to explore their profile and
                  department memberships.
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
