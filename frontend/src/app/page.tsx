import {
  ArrowRight,
  CheckCircle2,
  Database,
  LockKeyhole,
  PanelsTopLeft,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const workflow = [
  ["01", "Provision", "Create the first administrator outside the browser."],
  ["02", "Model", "Shape departments, modules, and fields around your team."],
  ["03", "Operate", "Work with validated records in one focused workspace."],
] as const;

export default function Home() {
  return (
    <main className="bg-background text-foreground min-h-screen">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 lg:px-10">
        <a className="flex items-center gap-3" href="/">
          <span className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-[var(--radius)] text-sm font-bold">
            OS
          </span>
          <span className="text-sm font-semibold tracking-[0.16em] uppercase">
            OpenSlate
          </span>
        </a>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <a href="/setup">First deployment?</a>
          </Button>
          <Button asChild size="sm">
            <a href="/login">
              Sign in <ArrowRight aria-hidden="true" />
            </a>
          </Button>
        </nav>
      </header>

      <section className="mx-auto grid max-w-7xl gap-14 px-6 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:px-10 lg:py-28">
        <div className="max-w-3xl self-center">
          <p className="text-primary mb-6 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] uppercase">
            <span className="bg-success size-2 rounded-full" /> Operations
            workspace
          </p>
          <h1 className="text-5xl leading-[1.02] font-semibold tracking-[-0.05em] text-balance sm:text-7xl">
            Make the next action obvious.
          </h1>
          <p className="text-muted-foreground mt-7 max-w-2xl text-lg leading-8">
            OpenSlate gives teams a calm, structured place to design their
            operational data and keep work moving from setup to everyday
            records.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <a href="/login">
                Open workspace <ArrowRight aria-hidden="true" />
              </a>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a href="/setup">Read setup guide</a>
            </Button>
          </div>
          <div className="text-muted-foreground mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm">
            <span className="inline-flex items-center gap-2">
              <LockKeyhole size={15} className="text-primary" /> Self-hosted
              access
            </span>
            <span className="inline-flex items-center gap-2">
              <Database size={15} className="text-primary" /> PostgreSQL-backed
            </span>
          </div>
        </div>

        <div className="border-border bg-card rounded-[calc(var(--radius)*1.5)] border p-5 shadow-sm sm:p-7">
          <div className="border-border flex items-center justify-between border-b pb-5">
            <div>
              <p className="text-muted-foreground text-xs font-semibold tracking-[0.16em] uppercase">
                Launch sequence
              </p>
              <h2 className="mt-2 text-xl font-semibold">A guided start</h2>
            </div>
            <PanelsTopLeft className="text-primary" aria-hidden="true" />
          </div>
          <div className="divide-border divide-y">
            {workflow.map(([number, title, description]) => (
              <div className="flex gap-4 py-5" key={number}>
                <span className="text-muted-foreground font-mono text-xs">
                  {number}
                </span>
                <div>
                  <h3 className="font-medium">{title}</h3>
                  <p className="text-muted-foreground mt-1 text-sm leading-6">
                    {description}
                  </p>
                </div>
                <CheckCircle2
                  className="text-muted-foreground/40 ml-auto shrink-0"
                  size={18}
                  aria-hidden="true"
                />
              </div>
            ))}
          </div>
        </div>
      </section>
      <footer className="border-border text-muted-foreground mx-auto flex max-w-7xl flex-col gap-2 border-t px-6 py-6 text-xs sm:flex-row sm:justify-between lg:px-10">
        <span>OpenSlate Operations</span>
        <span>Next.js · FastAPI · PostgreSQL</span>
      </footer>
    </main>
  );
}
