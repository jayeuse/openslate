"use client";
import { useState } from "react";
import { useSampleState } from "@/components/sample/sample-state";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "@/components/sample/sample-data";
import { Action, Choice, Panel } from "../comms/ui";

const EXAMPLE = [
  { task: "Inspect emergency pump", client: "Riverside Industrial" },
  { task: "Replace valve gasket", client: "Northvale Co." },
  { task: "", client: "Cedar Ridge Facilities" },
];
export default function ImportExport() {
  const [records, setRecords] = useSampleState<SampleRecord[]>(
    "records",
    INITIAL_RECORDS,
  );
  const [format, setFormat] = useState("CSV");
  const [titleColumn, setTitleColumn] = useState("task");
  const [customerColumn, setCustomerColumn] = useState("client");
  const [preview, setPreview] = useState(false);
  const [exporting, setExporting] = useState(false);
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
          label="Sample spreadsheet format"
          value={format}
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
        <Action onClick={() => setPreview(true)}>Preview import</Action>
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
              Only valid rows will be added to this sample workspace.
            </p>
            <div className="flex flex-wrap gap-2">
              <Action
                variant="default"
                disabled={!valid.length}
                onClick={() => {
                  setRecords((items) => [
                    ...items,
                    ...valid.map((row) => ({
                      id: `sample-import-${crypto.randomUUID()}`,
                      title: row.title,
                      customer: row.customer,
                      status: "Open",
                      assignee: "Unassigned",
                      dueDate: "2026-09-30",
                    })),
                  ]);
                  setNotice(
                    `${valid.length} sample records imported. Invalid rows were excluded.`,
                  );
                  setPreview(false);
                }}
              >
                Import {valid.length} valid sample rows
              </Action>
              <Action onClick={() => setPreview(false)}>Cancel import</Action>
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
          Inspect a preview of your {records.length} sample records. This
          demonstration does not create or download a file.
        </p>
        <Choice
          label="Export format"
          value={format}
          onChange={(event) => {
            setFormat(event.target.value);
            setExporting(false);
          }}
        >
          <option>CSV</option>
          <option>XLSX</option>
        </Choice>
        <Action onClick={() => setExporting(true)}>Preview export</Action>
        {exporting && (
          <section className="space-y-3">
            <h3 className="font-semibold">{format} export preview</h3>
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
                  {records.map((record) => (
                    <tr key={record.id} className="border-t">
                      <td className="p-3">{record.title}</td>
                      <td className="p-3">{record.customer}</td>
                      <td className="p-3">{record.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Action onClick={() => setExporting(false)}>
              Close export preview
            </Action>
          </section>
        )}
      </Panel>
    </div>
  );
}
