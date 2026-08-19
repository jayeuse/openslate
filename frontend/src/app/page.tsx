import { ArrowUpRight, Database, Files, ShieldCheck } from "lucide-react";

import { ApiStatus } from "@/components/api-status";
import { Button } from "@/components/ui/button";

const foundations = [
  {
    title: "Structured data",
    description: "PostgreSQL records with JSONB where the model needs room to evolve.",
    icon: Database,
  },
  {
    title: "Local ownership",
    description: "Files stay on infrastructure you control, with no external storage dependency.",
    icon: Files,
  },
  {
    title: "Access by design",
    description: "Argon2 credentials and role-based boundaries form the starting security model.",
    icon: ShieldCheck,
  },
];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-stone-950 text-stone-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_75%_20%,rgba(163,230,53,0.12),transparent_32%),linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:auto,48px_48px,48px_48px]" />
      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-6 sm:px-10 lg:px-16">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-lime-300 text-sm font-black text-stone-950">
              OS
            </span>
            <span className="font-mono text-sm tracking-[0.18em] uppercase">OpenSlate</span>
          </div>
          <ApiStatus />
        </header>

        <section className="grid flex-1 items-center gap-14 py-20 lg:grid-cols-[1.3fr_0.7fr] lg:py-28">
          <div>
            <p className="mb-6 font-mono text-xs tracking-[0.24em] text-lime-300 uppercase">
              Operations without lock-in
            </p>
            <h1 className="max-w-4xl text-5xl leading-[0.95] font-semibold tracking-[-0.055em] text-balance sm:text-7xl lg:text-8xl">
              Your business,<br />
              on an open slate.
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-stone-400 sm:text-xl">
              A self-hosted foundation for modeling teams, records, relationships, files, and
              reports around the way your organization actually works.
            </p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <a href="/docs">
                  Explore the API <ArrowUpRight aria-hidden="true" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="https://github.com" rel="noreferrer" target="_blank">
                  View repository
                </a>
              </Button>
            </div>
          </div>

          <div className="border-l border-white/10 lg:pl-10">
            <p className="mb-8 font-mono text-xs tracking-[0.2em] text-stone-500 uppercase">
              Core foundation / 01
            </p>
            <div className="space-y-8">
              {foundations.map(({ title, description, icon: Icon }) => (
                <article className="group grid grid-cols-[auto_1fr] gap-4" key={title}>
                  <div className="grid size-10 place-items-center rounded-full border border-white/15 text-lime-300 transition-colors group-hover:border-lime-300/60">
                    <Icon aria-hidden="true" size={17} />
                  </div>
                  <div>
                    <h2 className="font-medium text-stone-100">{title}</h2>
                    <p className="mt-2 text-sm leading-6 text-stone-500">{description}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <footer className="flex flex-col gap-2 border-t border-white/10 pt-5 font-mono text-[11px] tracking-wider text-stone-600 uppercase sm:flex-row sm:items-center sm:justify-between">
          <span>Next.js + FastAPI + PostgreSQL</span>
          <span>Self-hosted by default</span>
        </footer>
      </div>
    </main>
  );
}
