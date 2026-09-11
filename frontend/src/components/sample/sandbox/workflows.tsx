import { useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSampleState } from "@/components/sample/sample-state";
import { initialRoles, type Role } from "@/components/sample/access/model";
import { Control, selectClass } from "./designer";
import {
  changesFrom,
  counts,
  reorder,
  uid,
  type Design,
  type Version,
} from "./model";
type Props = {
  section: string;
  design: Design;
  change: (d: Design) => void;
  versions: Version[];
  setVersions: Dispatch<SetStateAction<Version[]>>;
  navigate: (s: string) => void;
  notify: (s: string) => void;
};
type Simulation = {
  records: {
    id: string;
    title: string;
    priority: string;
    status: string;
    assignee: string;
  }[];
  users: { id: string; name: string; role: string }[];
  results: string[];
  runs: { id: string; rule: string; result: string }[];
};
const empty: Simulation = { records: [], users: [], results: [], runs: [] };

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (s: string) => void;
}) {
  return (
    <Control label={label}>
      <select
        aria-label={label}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
    </Control>
  );
}
export function Workflows({
  section,
  design,
  change,
  versions,
  setVersions,
  navigate,
  notify,
}: Props) {
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("New record");
  const [condition, setCondition] = useState("Priority is urgent");
  const [action, setAction] = useState("Send a notification");
  const [creating, setCreating] = useState(false);
  const [historyRule, setHistoryRule] = useState("");
  const [sim, setSim] = useSampleState<Simulation>("sandbox.simulation", empty);
  const [role, setRole] = useState("Administrator");
  const [accessRoles] = useSampleState<Role[]>("access-roles", initialRoles);
  const roles = accessRoles.map((entry) => entry.name);
  const activeRole = accessRoles.find((entry) => entry.name === role);
  const isAdmin = activeRole?.id === "sample-admin";
  const canRead = (module: Design["modules"][number]) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes("Action · read") &&
          activeRole.grants.includes(`Module · ${module.name}`) &&
          activeRole.grants.includes(
            `Department · ${design.departments.find((department) => department.id === module.department)?.name}`,
          ))),
    );
  const canEdit = Boolean(
    activeRole &&
    (isAdmin ||
      activeRole.grants.includes("Action · update") ||
      activeRole.grants.includes("Action · create")),
  );

  const [scenario, setScenario] = useState("New record");
  const [preview, setPreview] = useState(design);
  const [compareA, setCompareA] = useState(versions[0]?.id ?? "");
  const [compareB, setCompareB] = useState(versions.at(-1)?.id ?? "");
  const [comparing, setComparing] = useState(false);
  const [confirm, setConfirm] = useState<{
    kind: "restore" | "delete" | "rollback";
    id: string;
  } | null>(null);
  const published = versions.filter((v) => v.published);
  function run() {
    if (!sim.records.length) {
      notify("Load sample records before running a scenario.");
      return;
    }
    let records = [...sim.records];
    const results: string[] = [];
    const runs: Simulation["runs"] = [];
    if (!canEdit || !design.modules.some(canRead))
      results.push(
        `${role}: record changes denied by sample Access permissions.`,
      );
    else {
      results.push(`${role}: ${scenario} scenario accepted.`);
      for (const rule of design.rules.filter((r) => r.enabled)) {
        let result = "Skipped: trigger or condition did not match.";
        const matchingRecords = records.filter(
          (record) =>
            rule.condition === "Always" ||
            (rule.condition === "Priority is urgent" &&
              record.priority === "Urgent") ||
            (rule.condition === "Status is open" && record.status === "Open"),
        );
        if (rule.trigger === scenario && matchingRecords.length) {
          switch (rule.action) {
            case "Send a notification":
              result = "Sample notification: Urgent request needs attention.";
              break;
            case "Send a channel message":
              result =
                "Sample channel message: Operations, urgent request needs attention.";
              break;
            case "Create a record":
              records.push({
                id: uid(),
                title: "Automation follow-up",
                priority: "Normal",
                status: "Open",
                assignee: "Unassigned",
              });
              result = "Sample follow-up record created.";
              break;
            case "Update a field":
              records = records.map((r) =>
                matchingRecords.includes(r)
                  ? { ...r, status: "In progress" }
                  : r,
              );
              result = "Sample Status field updated to In progress.";
              break;
            case "Assign a task":
              records = records.map((r) =>
                matchingRecords.includes(r)
                  ? { ...r, assignee: sim.users[0]?.name ?? "Sample operator" }
                  : r,
              );
              result = "Sample task assigned to test operator.";
              break;
          }
        }
        results.push(result);
        runs.push({ id: uid(), rule: rule.name, result });
      }
    }
    setSim({ ...sim, records, results, runs: [...runs, ...sim.runs] });
  }
  function apply() {
    if (!confirm) return;
    const v = versions.find((x) => x.id === confirm.id);
    if (!v) return;
    if (confirm.kind === "delete") {
      setVersions((all) => all.filter((x) => x.id !== v.id));
      notify("Old sample version deleted.");
    } else {
      change(v.design);
      if (confirm.kind === "rollback")
        setVersions((all) => [
          ...all,
          {
            id: uid(),
            label: `Rollback to ${v.label}`,
            design: v.design,
            published: true,
            date: new Date().toLocaleString(),
          },
        ]);
      notify(
        `Sample design restored from ${v.label}. Live workspace unchanged.`,
      );
    }
    setConfirm(null);
  }
  return (
    <div className="space-y-6">
      {section === "Automation" && (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Automation rules</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Rules run in priority order, inside Simulation only.
              </p>
            </div>
            <Button
              onClick={() => {
                setCreating(true);
                setName("");
              }}
            >
              Create rule
            </Button>
          </div>
          {creating && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                change({
                  ...design,
                  rules: [
                    ...design.rules,
                    {
                      id: uid(),
                      name: name.trim(),
                      trigger,
                      condition,
                      action,
                      enabled: true,
                    },
                  ],
                });
                setCreating(false);
                notify("Sample automation rule created.");
              }}
              className="bg-card grid gap-4 rounded-xl border p-5 md:grid-cols-2"
            >
              <Control label="Rule name">
                <Input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Control>
              <Choice
                label="Trigger"
                value={trigger}
                onChange={setTrigger}
                options={[
                  "Field change",
                  "Threshold",
                  "Schedule",
                  "New record",
                ]}
              />
              <Choice
                label="Condition"
                value={condition}
                onChange={setCondition}
                options={["Always", "Priority is urgent", "Status is open"]}
              />
              <Choice
                label="Action"
                value={action}
                onChange={setAction}
                options={[
                  "Send a notification",
                  "Send a channel message",
                  "Create a record",
                  "Update a field",
                  "Assign a task",
                ]}
              />
              <div className="flex gap-2">
                <Button type="submit">Save rule</Button>
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
          <div className="divide-border bg-card divide-y rounded-xl border">
            {design.rules.map((r, i) => (
              <article
                key={r.id}
                className="flex flex-wrap justify-between gap-4 p-5"
              >
                <div>
                  <p className="text-muted-foreground text-xs">
                    PRIORITY {i + 1} · {r.enabled ? "Enabled" : "Disabled"}
                  </p>
                  <h3 className="mt-2 font-semibold">{r.name}</h3>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {r.trigger} · {r.condition} → {r.action}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      change({
                        ...design,
                        rules: design.rules.map((x) =>
                          x.id === r.id ? { ...x, enabled: !x.enabled } : x,
                        ),
                      })
                    }
                  >
                    {r.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!i}
                    onClick={() =>
                      change({ ...design, rules: reorder(design.rules, i, -1) })
                    }
                  >
                    Higher priority
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={i === design.rules.length - 1}
                    onClick={() =>
                      change({ ...design, rules: reorder(design.rules, i, 1) })
                    }
                  >
                    Lower priority
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate("Simulation")}
                  >
                    Test rule
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setHistoryRule(historyRule === r.name ? "" : r.name)
                    }
                  >
                    Run history
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      change({
                        ...design,
                        rules: design.rules.filter((x) => x.id !== r.id),
                      })
                    }
                  >
                    Delete rule
                  </Button>
                </div>
                {historyRule === r.name && (
                  <div className="bg-muted w-full rounded-lg p-4 text-sm">
                    {sim.runs.filter((x) => x.rule === r.name).length
                      ? sim.runs
                          .filter((x) => x.rule === r.name)
                          .map((x) => (
                            <p key={x.id} className="py-2">
                              {x.result}
                            </p>
                          ))
                      : "No sample runs yet. Test this rule in Simulation."}
                  </div>
                )}
              </article>
            ))}
            {!design.rules.length && (
              <p className="text-muted-foreground p-6 text-sm">
                No rules yet. Create a rule to begin.
              </p>
            )}
          </div>
        </>
      )}
      {section === "Simulation" && (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Simulation lab</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Test permissions and automation on disposable sample records.
              </p>
            </div>
            <Button variant="outline" onClick={() => navigate("Designer")}>
              Exit Simulation
            </Button>
          </div>
          <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
            <div className="bg-card space-y-4 rounded-xl border p-5">
              <Button
                className="w-full"
                variant="outline"
                onClick={() =>
                  setSim((s) => ({
                    ...s,
                    records: [
                      {
                        id: "sample-test-request",
                        title: "Urgent generator inspection",
                        priority: "Urgent",
                        status: "Open",
                        assignee: "Unassigned",
                      },
                    ],
                    results: [],
                  }))
                }
              >
                Load sample records
              </Button>
              <Choice
                label="Simulation role"
                value={role}
                onChange={setRole}
                options={roles}
              />
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  setSim((s) => ({
                    ...s,
                    users: [...s.users, { id: uid(), name: name.trim(), role }],
                  }));
                  setName("");
                }}
              >
                <Control label="Test user name">
                  <Input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Control>
                <Button variant="outline" type="submit">
                  Create test user
                </Button>
              </form>
              {sim.users.map((u) => (
                <p key={u.id} className="text-muted-foreground text-xs">
                  {u.name} · {u.role}
                </p>
              ))}
              <Choice
                label="Test scenario"
                value={scenario}
                onChange={setScenario}
                options={[
                  "New record",
                  "Field change",
                  "Threshold",
                  "Schedule",
                ]}
              />
              <Button className="w-full" onClick={run}>
                Run scenario
              </Button>
              <Button
                className="w-full"
                variant="ghost"
                onClick={() => setSim(empty)}
              >
                Reset simulation
              </Button>
            </div>
            <div className="space-y-5">
              <div className="bg-card rounded-xl border p-5">
                <h3 className="mb-4 font-semibold">Sample records</h3>
                {sim.records.length ? (
                  sim.records.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap justify-between gap-2 border-t py-4 text-sm"
                    >
                      <strong>{r.title}</strong>
                      <span>
                        {r.status} · {r.assignee}
                        <Choice
                          label={`Priority for ${r.title}`}
                          value={r.priority}
                          options={["Normal", "Urgent"]}
                          onChange={(priority) =>
                            setSim((previous) => ({
                              ...previous,
                              records: previous.records.map((record) =>
                                record.id === r.id
                                  ? { ...record, priority }
                                  : record,
                              ),
                            }))
                          }
                        />
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground text-sm">
                    No simulation records loaded.
                  </p>
                )}
              </div>
              <div className="bg-card rounded-xl border p-5">
                <h3 className="mb-4 font-semibold">Scenario result</h3>
                {sim.results.length ? (
                  sim.results.map((r, i) => (
                    <p key={`${i}-${r}`} className="border-t py-3 text-sm">
                      {r}
                    </p>
                  ))
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Choose a role and run a scenario to inspect the outcome.
                  </p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
      {section === "Preview" && (
        <>
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Workspace preview</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {role} ·{" "}
                {!canEdit
                  ? "Read only"
                  : isAdmin
                    ? "Full sample access"
                    : "Record editing"}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Choice
                label="Preview role"
                value={role}
                onChange={setRole}
                options={roles}
              />
              <Button
                variant="outline"
                onClick={() => {
                  setPreview(design);
                  notify("Preview refreshed from the current sample design.");
                }}
              >
                Refresh Preview
              </Button>
              <Button variant="ghost" onClick={() => navigate("Designer")}>
                Exit Preview
              </Button>
            </div>
          </div>
          {!preview.modules.some(canRead) && (
            <p className="text-muted-foreground rounded-xl border p-6 text-sm">
              This role has no readable modules. Grant department, module, and
              read access in Sample Access.
            </p>
          )}
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {preview.modules
              .filter(
                (m) =>
                  canRead(m) &&
                  !m.closed &&
                  !preview.departments.find((d) => d.id === m.department)
                    ?.closed,
              )
              .map((m) => (
                <article
                  key={m.id}
                  className="bg-card space-y-4 rounded-xl border p-5"
                >
                  <p className="text-muted-foreground text-xs">
                    {
                      preview.departments.find((d) => d.id === m.department)
                        ?.name
                    }
                  </p>
                  <h3 className="text-lg font-semibold">{m.name}</h3>
                  {m.fields
                    .filter((f) => !f.closed)
                    .map((f) => (
                      <Control
                        key={f.id}
                        label={`${f.name}${f.required ? " *" : ""}`}
                      >
                        <Input
                          placeholder={
                            f.value || `Sample ${f.type.toLowerCase()}`
                          }
                          disabled={!canEdit}
                        />
                      </Control>
                    ))}
                  <p className="text-muted-foreground text-xs">
                    Preview inputs are temporary. Use Simulation to test
                    changes.
                  </p>
                </article>
              ))}
          </div>
        </>
      )}
      {section === "Publish" && (
        <div className="bg-card mx-auto max-w-2xl rounded-xl border p-6 md:p-8">
          <p className="text-muted-foreground text-xs tracking-widest uppercase">
            Review · Confirm · Sample release
          </p>
          <h2 className="mt-3 text-2xl font-semibold">Publish sample design</h2>
          <p className="text-muted-foreground mt-3 text-sm">
            Review the structure before creating a published sample snapshot.
            Your live system is unchanged.
          </p>
          <div className="bg-muted my-6 space-y-3 rounded-lg p-4 text-sm">
            <p>
              <strong>Previous publication</strong>
              <br />
              {published.at(-1) ? counts(published.at(-1)!.design) : "None"}
            </p>
            <p>
              <strong>Current draft</strong>
              <br />
              {counts(design)}
            </p>
            <ul className="list-inside list-disc space-y-1">
              {changesFrom(published.at(-1)?.design, design).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                setVersions((all) => [
                  ...all,
                  {
                    id: uid(),
                    label: `Release ${published.length + 1}`,
                    design,
                    published: true,
                    date: new Date().toLocaleString(),
                  },
                ]);
                notify("Sample design published. Live workspace unchanged.");
                navigate("Versions");
              }}
            >
              Confirm sample publish
            </Button>
            <Button variant="ghost" onClick={() => navigate("Designer")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {section === "Versions" && (
        <>
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">
                Versions & publish history
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Keep checkpoints, compare designs, and restore with confidence.
              </p>
            </div>
            <Button
              variant="outline"
              disabled={published.length < 2}
              onClick={() =>
                setConfirm({ kind: "rollback", id: published.at(-2)!.id })
              }
            >
              Roll back previous publication
            </Button>
          </div>
          <div className="bg-card flex flex-wrap items-end gap-3 rounded-xl border p-5">
            {[
              {
                label: "Compare first version",
                value: compareA,
                set: setCompareA,
              },
              {
                label: "Compare second version",
                value: compareB,
                set: setCompareB,
              },
            ].map((c) => (
              <Control key={c.label} label={c.label}>
                <select
                  className={selectClass}
                  value={c.value}
                  onChange={(e) => c.set(e.target.value)}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </Control>
            ))}
            <Button variant="outline" onClick={() => setComparing(true)}>
              Compare versions
            </Button>
          </div>
          {comparing && (
            <div className="grid gap-4 md:grid-cols-2">
              {[compareA, compareB].map((id, i) => {
                const v = versions.find((x) => x.id === id);
                return (
                  <div key={i} className="bg-card rounded-xl border p-5">
                    <h3 className="font-semibold">
                      {v?.label ?? "Select a version"}
                    </h3>
                    {v && (
                      <>
                        <p className="text-muted-foreground my-3 text-sm">
                          {counts(v.design)}
                        </p>
                        {v.design.departments.map((d) => (
                          <p key={d.id} className="text-sm">
                            {d.name}
                            {d.closed ? " · Closed" : ""}
                          </p>
                        ))}
                        {v.design.modules.map((m) => (
                          <div key={m.id} className="border-t py-3 text-sm">
                            <strong>
                              {m.name}
                              {m.closed ? " (Closed)" : ""}
                            </strong>
                            <p className="text-muted-foreground text-xs">
                              {m.fields
                                .map(
                                  (f) =>
                                    `${f.name}: ${f.type}${f.required ? " required" : ""}${f.closed ? " closed" : ""}${f.value ? ` default ${f.value}` : ""}${f.options ? ` options ${f.options}` : ""}`,
                                )
                                .join(" · ")}
                            </p>
                          </div>
                        ))}
                        {v.design.relationships.map((r) => (
                          <p key={r.id} className="text-xs">
                            {r.name} · {r.cardinality}
                          </p>
                        ))}
                        {v.design.rules.map((r) => (
                          <p key={r.id} className="text-xs">
                            {r.name} · {r.trigger} · {r.condition} · {r.action}{" "}
                            · {r.enabled ? "Enabled" : "Disabled"}
                          </p>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="divide-border bg-card divide-y rounded-xl border">
            {[...versions].reverse().map((v) => (
              <div
                key={v.id}
                className="flex flex-wrap justify-between gap-4 p-5"
              >
                <div>
                  <Control label={`Version label ${v.id}`}>
                    <Input
                      value={v.label}
                      onChange={(e) =>
                        setVersions((all) =>
                          all.map((x) =>
                            x.id === v.id ? { ...x, label: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </Control>
                  <p className="text-muted-foreground mt-2 text-xs">
                    {v.published ? "Published sample" : "Saved draft"} ·{" "}
                    {v.date}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setConfirm({ kind: "restore", id: v.id })}
                  >
                    Restore version
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      v.id === published.at(-1)?.id || versions.length === 1
                    }
                    onClick={() => setConfirm({ kind: "delete", id: v.id })}
                  >
                    Delete version
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {confirm && (
        <div
          role="region"
          aria-label="Confirm version action"
          className="bg-muted rounded-xl border p-5"
        >
          <h3 className="font-semibold">
            {confirm.kind === "delete"
              ? "Delete this sample version?"
              : "Restore this sample snapshot?"}
          </h3>
          <p className="my-3 text-sm">
            {confirm.kind === "delete"
              ? "This removes the checkpoint from this tab."
              : "The draft will use this snapshot. Undo remains available in the designer."}
          </p>
          <div className="flex gap-2">
            <Button onClick={apply}>Confirm {confirm.kind}</Button>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
