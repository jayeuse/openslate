"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Choice, Editor, Field, Section } from "../access/primitives";
const entries = [
  {
    id: "sample-audit-1",
    user: "Mara Santos",
    date: "2026-09-11",
    entity: "Work orders",
    action: "Update",
    target: "WO-1042",
    before: "Status: Assigned",
    after: "Status: In progress",
  },
  {
    id: "sample-audit-2",
    user: "Eli Cruz",
    date: "2026-09-10",
    entity: "Equipment",
    action: "Create",
    target: "EQ-0028",
    before: "No equipment record",
    after: "Pump · North depot · Active",
  },
  {
    id: "sample-audit-3",
    user: "Mara Santos",
    date: "2026-09-09",
    entity: "Users",
    action: "Close",
    target: "Nina Reyes",
    before: "User: Active",
    after: "User: Deactivated",
  },
];
export default function SampleAudit() {
  const [user, setUser] = useState("All users");
  const [entity, setEntity] = useState("All entities");
  const [action, setAction] = useState("All actions");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<(typeof entries)[number] | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const visible = entries.filter(
    (entry) =>
      (user === "All users" || entry.user === user) &&
      (entity === "All entities" || entry.entity === entity) &&
      (action === "All actions" || entry.action === action) &&
      (!from || entry.date >= from) &&
      (!to || entry.date <= to),
  );
  return (
    <Section
      title="Audit trail"
      description="A readable history of fictional workspace activity. Filters apply to the export preview too."
    >
      <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-5">
        <Choice
          label="Audit user"
          value={user}
          options={["All users", "Mara Santos", "Eli Cruz"]}
          onChange={setUser}
        />
        <Choice
          label="Audit entity"
          value={entity}
          options={["All entities", "Work orders", "Equipment", "Users"]}
          onChange={setEntity}
        />
        <Choice
          label="Audit action"
          value={action}
          options={["All actions", "Create", "Update", "Close"]}
          onChange={setAction}
        />
        <Field
          label="From date"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <Field
          label="To date"
          type="date"
          value={to}
          min={from}
          onChange={(event) => setTo(event.target.value)}
        />
      </div>
      {from && to && from > to && (
        <p role="alert" className="text-destructive text-sm">
          The end date must be on or after the start date.
        </p>
      )}
      <div className="flex flex-wrap justify-between gap-3">
        <p className="text-muted-foreground self-center text-sm">
          {visible.length} entries
        </p>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => {
              setUser("All users");
              setEntity("All entities");
              setAction("All actions");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => setExporting(true)}
          >
            Export audit preview
          </Button>
        </div>
      </div>
      <div className="divide-y rounded-lg border">
        {visible.map((entry) => (
          <button
            key={entry.id}
            className="hover:bg-muted focus-visible:outline-ring grid min-h-11 w-full gap-2 p-4 text-left sm:grid-cols-[120px_1fr_1fr_auto]"
            onClick={() => setSelected(entry)}
            aria-label={`View audit ${entry.target}`}
          >
            <span className="text-muted-foreground text-sm">{entry.date}</span>
            <span className="text-sm font-medium">{entry.user}</span>
            <span className="text-muted-foreground text-sm">
              {entry.action} · {entry.entity}
            </span>
            <span className="text-sm">{entry.target}</span>
          </button>
        ))}
        {!visible.length && (
          <p className="text-muted-foreground p-8 text-center text-sm">
            No audit entries match these filters.
          </p>
        )}
      </div>
      <Editor
        title="Audit entry detail"
        open={selected !== null}
        onClose={() => setSelected(null)}
      >
        {selected && (
          <div className="space-y-5">
            <p className="text-muted-foreground text-sm">
              {selected.user} · {selected.date} · {selected.action}
            </p>
            <h3 className="font-semibold">{selected.target}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-md border p-4">
                <p className="text-muted-foreground mb-2 text-xs uppercase">
                  Before
                </p>
                <p className="text-sm">{selected.before}</p>
              </div>
              <div className="bg-muted rounded-md border p-4">
                <p className="text-muted-foreground mb-2 text-xs uppercase">
                  After
                </p>
                <p className="text-sm">{selected.after}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              Synthetic entry · {selected.id}
            </p>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setSelected(null)}
            >
              Close detail
            </Button>
          </div>
        )}
      </Editor>
      <Editor
        title="Audit export preview"
        open={exporting}
        onClose={() => setExporting(false)}
      >
        <p className="text-muted-foreground mb-4 text-sm">
          {visible.length} filtered entries · CSV preview only. No file was
          downloaded.
        </p>
        <pre className="bg-muted overflow-auto rounded-md p-4 text-xs">
          {[
            "Date,User,Entity,Action,Target",
            ...visible.map(
              (entry) =>
                `${entry.date},${entry.user},${entry.entity},${entry.action},${entry.target}`,
            ),
          ].join("\n")}
        </pre>
        <Button
          variant="outline"
          className="mt-4 min-h-11"
          onClick={() => setExporting(false)}
        >
          Close preview
        </Button>
      </Editor>
    </Section>
  );
}
