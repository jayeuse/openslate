"use client";

import { ArrowDown, ArrowUp, Pin, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useSampleState } from "../sample-state";
import { initialRoles } from "../access/model";
import type { SampleRecord } from "@/components/sample/sample-data";

export type SampleWidget = {
  id: string;
  type: string;
  size: string;
  permission: string;
  refresh: string;
  pinned: boolean;
};
export function newWidget(type: string): SampleWidget {
  return {
    id: `sample-widget-${crypto.randomUUID()}`,
    type,
    size: "Half",
    permission: "Everyone",
    refresh: "Manual",
    pinned: false,
  };
}
export function WidgetSurface({
  widgets,
  onChange,
  records,
  board = false,
}: {
  widgets: SampleWidget[];
  onChange: (widgets: SampleWidget[]) => void;
  records: SampleRecord[];
  board?: boolean;
}) {
  const [roles] = useSampleState("access-roles", initialRoles);
  function update(id: string, change: Partial<SampleWidget>) {
    onChange(
      widgets.map((widget) =>
        widget.id === id ? { ...widget, ...change } : widget,
      ),
    );
  }
  function move(index: number, direction: number) {
    const next = [...widgets];
    [next[index], next[index + direction]] = [
      next[index + direction],
      next[index],
    ];
    onChange(next);
  }
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {widgets.map((widget, index) => (
        <section
          key={widget.id}
          className={`bg-card min-w-0 rounded-xl border ${widget.size === "Full" ? "lg:col-span-2" : ""}`}
          aria-label={`${widget.type} widget`}
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-4">
            <h3 className="font-medium">
              {widget.pinned && (
                <Pin className="mr-2 inline size-3" aria-label="Pinned" />
              )}
              {widget.type === "OpenView"
                ? "OpenView · Service requests"
                : widget.type}
            </h3>
            <div className="flex gap-1">
              {board && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${widget.pinned ? "Unpin" : "Pin"} ${widget.type}`}
                  onClick={() => update(widget.id, { pinned: !widget.pinned })}
                >
                  <Pin />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                disabled={index === 0}
                aria-label={`Move ${widget.type} up`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={index === widgets.length - 1}
                aria-label={`Move ${widget.type} down`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove ${widget.type}`}
                onClick={() =>
                  onChange(widgets.filter((item) => item.id !== widget.id))
                }
              >
                <Trash2 />
              </Button>
            </div>
          </header>
          <div className="p-5">
            {widget.type === "Workload" ? (
              <div className="space-y-4">
                {[...new Set(records.map((record) => record.assignee))].map(
                  (name) => (
                    <div key={name}>
                      <div className="mb-2 flex justify-between text-sm">
                        <span>{name}</span>
                        <span>
                          {
                            records.filter((record) => record.assignee === name)
                              .length
                          }
                        </span>
                      </div>
                      <div className="bg-muted h-2 rounded-full">
                        <div
                          className="bg-foreground/75 h-full rounded-full"
                          style={{
                            width: `${(records.filter((record) => record.assignee === name).length / Math.max(records.length, 1)) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : widget.type === "Summary" ? (
              <>
                <p className="text-5xl font-semibold tracking-tight">
                  {records.length}
                </p>
                <p className="text-muted-foreground mt-2 text-sm">
                  Service requests across your sample organization
                </p>
                <div className="mt-6 flex flex-wrap gap-5 border-t pt-4 text-sm">
                  {[...new Set(records.map((record) => record.status))].map(
                    (status) => (
                      <span key={status}>
                        {status}{" "}
                        <strong className="ml-2">
                          {
                            records.filter((record) => record.status === status)
                              .length
                          }
                        </strong>
                      </span>
                    ),
                  )}
                </div>
              </>
            ) : (
              <div className="divide-y">
                {records.slice(0, 4).map((record) => (
                  <a
                    key={record.id}
                    href={`/openview?record=${encodeURIComponent(record.id)}`}
                    className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
                  >
                    <span>
                      {record.title}
                      <small className="text-muted-foreground mt-1 block">
                        {record.customer}
                      </small>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {record.dueDate}
                    </span>
                  </a>
                ))}
                {records.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    No sample records yet.
                  </p>
                )}
              </div>
            )}
          </div>
          <details className="border-t px-5 py-3">
            <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
              Layout & access
            </summary>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs">
                Width
                <Select
                  aria-label={`${widget.type} width`}
                  value={widget.size}
                  onValueChange={(size) => update(widget.id, { size })}
                >
                  {["Half", "Full"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1 text-xs">
                Permission
                <Select
                  aria-label={`${widget.type} permission`}
                  value={widget.permission}
                  onValueChange={(permission) =>
                    update(widget.id, { permission })
                  }
                >
                  {["Everyone", ...roles.map((role) => role.name)].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1 text-xs">
                Refresh preview
                <Select
                  aria-label={`${widget.type} refresh`}
                  value={widget.refresh}
                  onValueChange={(refresh) => update(widget.id, { refresh })}
                >
                  {["Manual", "Every minute", "Every 5 minutes"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </Select>
              </label>
            </div>
            <p className="text-muted-foreground mt-3 text-xs">
              Sample access and refresh settings; no background requests are
              scheduled.
            </p>
          </details>
        </section>
      ))}
      {widgets.length === 0 && (
        <div className="text-muted-foreground border border-dashed p-12 text-center lg:col-span-2">
          A clear canvas. Add your first widget.
        </div>
      )}
    </div>
  );
}
