"use client";
import { useState } from "react";
import { type SampleRecord } from "@/components/systems/shared/data/sample-data";
import { sampleOperationMessage } from "../../shared/runtime/sample-async";
import type { Person } from "../../access/domain/model";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Action, Choice, Panel } from "../../shared/components/ui";
import type {
  PlatformCommandResult,
  PlatformImportRow,
} from "../adapters/runtime";

const EXAMPLE = [
  { task: "Inspect emergency pump", client: "Riverside Industrial" },
  { task: "Replace valve gasket", client: "Northvale Co." },
  { task: "", client: "Cedar Ridge Facilities" },
];
type ImportExportProps = {
  records: SampleRecord[];
  people: Person[];
  onImport: (
    rows: readonly PlatformImportRow[],
  ) => Promise<PlatformCommandResult<SampleRecord[]>>;
  onPrepareExport: () => Promise<{
    kind: "complete";
    queryKey: string;
    items: readonly SampleRecord[];
  }>;
  pending: (key?: string) => boolean;
};

export default function ImportExport({
  records,
  people,
  onImport,
  onPrepareExport,
  pending,
}: ImportExportProps) {
  const importing = pending("platform:records:import");
  const preparingExport = pending("platform:export");
  const [format, setFormat] = useState("CSV");
  const [titleColumn, setTitleColumn] = useState("task");
  const [customerColumn, setCustomerColumn] = useState("client");
  const [defaultAssignee, setDefaultAssignee] = useState("Unassigned");
  const [defaultDueDate, setDefaultDueDate] = useState("");
  const [preview, setPreview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportRows, setExportRows] = useState<readonly SampleRecord[] | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const mapped = EXAMPLE.map((row, index) => ({
    row: index + 1,
    title:
      titleColumn === "task"
        ? row.task
        : titleColumn === "client"
          ? row.client
          : "",
    customer:
      customerColumn === "client"
        ? row.client
        : customerColumn === "task"
          ? row.task
          : "",
  }));
  const valid = mapped.filter((row) => row.title.trim());
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <Panel title="Import records">
        <p className="text-muted-foreground text-sm">
          Try the bundled repair-jobs spreadsheet. No files leave your device
          and no live records are created.
        </p>
        <Choice
          label="Spreadsheet format"
          value={format}
          disabled={importing || preparingExport}
          onChange={(event) => {
            setFormat(event.target.value);
            setPreview(false);
          }}
        >
          <option>CSV</option>
          <option>XLSX</option>
        </Choice>
        <div className="bg-muted/30 rounded-lg border p-4 text-sm">
          <strong>repair-jobs.{format.toLowerCase()}</strong>
          <p className="text-muted-foreground mt-1">
            3 example rows · task and client columns
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Choice
            label="Map title field"
            value={titleColumn}
            disabled={importing || preparingExport}
            onChange={(event) => {
              setTitleColumn(event.target.value);
              setPreview(false);
            }}
          >
            <option value="">Unmapped</option>
            <option value="task">task</option>
            <option value="client">client</option>
          </Choice>
          <Choice
            label="Map customer field"
            value={customerColumn}
            disabled={importing || preparingExport}
            onChange={(event) => {
              setCustomerColumn(event.target.value);
              setPreview(false);
            }}
          >
            <option value="">Unmapped</option>
            <option value="client">client</option>
            <option value="task">task</option>
          </Choice>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Choice
            label="Default assignee for imported records"
            value={defaultAssignee}
            disabled={importing || preparingExport}
            onChange={(event) => setDefaultAssignee(event.target.value)}
          >
            <option>Unassigned</option>
            {people
              .filter((person) => person.active)
              .map((person) => (
                <option key={person.name}>{person.name}</option>
              ))}
          </Choice>
          <Field>
            <FieldLabel htmlFor="platform-import-due-date">
              Default due date (optional)
            </FieldLabel>
            <Input
              id="platform-import-due-date"
              type="date"
              value={defaultDueDate}
              disabled={importing || preparingExport}
              onChange={(event) => setDefaultDueDate(event.target.value)}
            />
          </Field>
        </div>
        <Action
          onClick={() => setPreview(true)}
          disabled={importing || preparingExport}
        >
          Preview import
        </Action>
        {preview && (
          <div className="space-y-4">
            <h3 className="font-medium">Import validation</h3>
            {mapped.map((row) => (
              <div key={row.row} className="rounded-lg border p-3 text-sm">
                {row.title ? (
                  <>
                    <strong>Row {row.row}</strong>
                    <p>
                      {row.title} · {row.customer || "No customer"}
                    </p>
                  </>
                ) : (
                  <p className="text-destructive">
                    Row {row.row}: title is required.
                  </p>
                )}
              </div>
            ))}
            <p className="text-muted-foreground text-sm">
              Only valid rows will be added to this workspace in this browser.
            </p>
            <div className="flex flex-wrap gap-2">
              <Action
                variant="default"
                disabled={!valid.length || importing}
                onClick={() => {
                  void (async () => {
                    const result = await onImport(
                      valid.map((row) => ({
                        title: row.title,
                        customer: row.customer,
                        assignee: defaultAssignee,
                        dueDate: defaultDueDate,
                      })),
                    );
                    if (!result.ok) {
                      setNotice(result.error);
                      return;
                    }
                    setNotice(
                      `${result.value.length} records imported. Invalid rows were excluded.`,
                    );
                    setPreview(false);
                  })().catch((error: unknown) => {
                    setNotice(
                      sampleOperationMessage(
                        error,
                        "The records could not be imported. Keep the preview open and try again.",
                      ),
                    );
                  });
                }}
              >
                {importing
                  ? "Importing rows…"
                  : `Import ${valid.length} valid rows`}
              </Action>
              <Action onClick={() => setPreview(false)} disabled={importing}>
                Cancel import
              </Action>
            </div>
          </div>
        )}
        {notice && (
          <p role="status" className="bg-muted rounded-lg p-3 text-sm">
            {notice}
          </p>
        )}
      </Panel>
      <Panel title="Export records">
        <p className="text-muted-foreground text-sm">
          Inspect all {records.length} records before export. This preview does
          not create or download a file.
        </p>
        <Choice
          label="Export format"
          value={format}
          disabled={importing || preparingExport}
          onChange={(event) => {
            setFormat(event.target.value);
            setExporting(false);
            setExportRows(null);
          }}
        >
          <option>CSV</option>
          <option>XLSX</option>
        </Choice>
        <Action
          disabled={preparingExport}
          onClick={() => {
            void (async () => {
              const result = await onPrepareExport();
              setExportRows(result.items);
              setExporting(true);
            })().catch((error: unknown) => {
              setNotice(
                sampleOperationMessage(
                  error,
                  "The export could not be prepared. Try again.",
                ),
              );
            });
          }}
        >
          {preparingExport ? "Preparing export…" : "Preview export"}
        </Action>
        {exporting && (
          <section className="space-y-3">
            <h3 className="font-semibold">
              {format} export preview · {exportRows?.length ?? 0} records
            </h3>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted">
                  <tr>
                    {["Title", "Customer", "Status"].map((value) => (
                      <th key={value} className="p-3">
                        {value}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(exportRows ?? []).map((record) => (
                    <tr key={record.id} className="border-t">
                      <td className="p-3">{record.title}</td>
                      <td className="p-3">{record.customer}</td>
                      <td className="p-3">{record.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Action
              onClick={() => {
                setExporting(false);
                setExportRows(null);
              }}
            >
              Close export preview
            </Action>
          </section>
        )}
      </Panel>
    </div>
  );
}
