"use client";

import { useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Undo2, Redo2, Save, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSampleState } from "@/components/sample/sample-state";
import {
  counts,
  initialDesign,
  initialSandboxHistory,
  uid,
  type Design,
  type DesignUpdate,
  type Version,
} from "./model";
import type { SandboxCanvasLayout } from "@/components/sandbox/sandbox-canvas";
import { Designer } from "./designer";
import { Workflows } from "./workflows";

export default function SampleSandbox() {
  const [history, setHistory] = useSampleState<{
    past: Design[];
    present: Design;
    future: Design[];
  }>("sandbox.design", initialSandboxHistory);
  const [versions, setVersions] = useSampleState<Version[]>(
    "sandbox.versions",
    [
      {
        id: "sample-v1",
        label: "Starting structure",
        design: initialDesign,
        published: true,
        date: "Initial sample",
      },
    ],
  );
  const [section, setSection] = useState("Designer");
  const [message, setMessage] = useState("");
  const design = history.present;
  const search = useSearchParams();
  const requestedSelection =
    search.get("module") ?? search.get("department") ?? "sample-requests";
  const change = useCallback(
    (update: DesignUpdate) => {
      setHistory((h) => {
        const next = typeof update === "function" ? update(h.present) : update;
        if (next === h.present) return h;
        return {
          past: [...h.past, h.present].slice(-50),
          present: next,
          future: [],
        };
      });
    },
    [setHistory],
  );
  const initializeLayout = useCallback(
    (layout: SandboxCanvasLayout) => {
      setHistory((h) =>
        JSON.stringify(h.present.layout) === JSON.stringify(layout)
          ? h
          : { ...h, present: { ...h.present, layout } },
      );
    },
    [setHistory],
  );
  function save() {
    setVersions((v) => [
      ...v,
      {
        id: uid(),
        label: `Draft ${v.length + 1}`,
        design,
        published: false,
        date: new Date().toLocaleString(),
      },
    ]);
    setMessage("Sample draft saved. Find this snapshot in Versions.");
  }
  return (
    <section
      className={`space-y-5 ${section === "Designer" ? "xl:flex xl:h-[calc(100dvh-7rem)] xl:min-h-[640px] xl:flex-col xl:gap-5 xl:space-y-0" : ""}`}
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Organization designer
          </h1>
          <span className="text-muted-foreground rounded-md border px-2 py-1 text-xs">
            Draft
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            aria-label="Undo"
            disabled={!history.past.length}
            onClick={() =>
              setHistory((h) => ({
                past: h.past.slice(0, -1),
                present: h.past.at(-1)!,
                future: [h.present, ...h.future],
              }))
            }
          >
            <Undo2 />
            Undo
          </Button>
          <Button
            variant="outline"
            aria-label="Redo"
            disabled={!history.future.length}
            onClick={() =>
              setHistory((h) => ({
                past: [...h.past, h.present],
                present: h.future[0],
                future: h.future.slice(1),
              }))
            }
          >
            <Redo2 />
            Redo
          </Button>
          <Button variant="outline" onClick={save}>
            <Save />
            Save draft
          </Button>
          <Button onClick={() => setSection("Publish")}>
            Publish
            <ArrowUpRight />
          </Button>
        </div>
      </header>
      <nav
        aria-label="Sandbox sections"
        className="border-border flex flex-wrap gap-1 border-b pb-3"
      >
        {["Designer", "Automation", "Simulation", "Preview", "Versions"].map(
          (tab) => (
            <Button
              key={tab}
              variant={section === tab ? "secondary" : "ghost"}
              aria-pressed={section === tab}
              onClick={() => setSection(tab)}
            >
              {tab}
            </Button>
          ),
        )}
      </nav>
      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
      {section === "Designer" ? (
        <Designer
          key={requestedSelection}
          initialSelected={requestedSelection}
          design={design}
          change={change}
          initializeLayout={initializeLayout}
          notify={setMessage}
        />
      ) : (
        <Workflows
          section={section}
          design={design}
          change={change}
          versions={versions}
          setVersions={setVersions}
          navigate={setSection}
          notify={setMessage}
        />
      )}
      <footer className="border-border text-muted-foreground flex flex-wrap justify-between gap-2 border-t pt-3 text-xs">
        <span>{counts(design)}</span>
        <span>
          Tab-local draft · {history.past.length} undo steps available
        </span>
      </footer>
    </section>
  );
}
