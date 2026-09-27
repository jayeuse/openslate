import type { Metadata } from "next";
import { ArrowRight, CircleAlert, Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Setup guide" };

export default function SetupPage() {
  return (
    <main className="bg-background min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <a href="/" className="flex items-center gap-3">
          <span className="bg-foreground text-background grid size-9 place-items-center rounded-md text-sm font-bold">
            OS
          </span>
          <span className="text-sm font-semibold">OpenSlate</span>
        </a>
        <Button asChild variant="ghost">
          <a href="/login">Back to sign in</a>
        </Button>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-14 sm:py-24">
        <p className="text-primary text-xs font-semibold tracking-[0.18em] uppercase">
          First deployment
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          Provision the administrator before you enter.
        </h1>
        <p className="text-muted-foreground mt-5 max-w-2xl text-lg leading-8">
          For security, OpenSlate does not expose an unauthenticated
          administrator-creation endpoint. Create the first administrator during
          deployment, then return here to sign in.
        </p>
        <Alert variant="warning" className="mt-8 flex gap-3">
          <CircleAlert className="mt-0.5 shrink-0" size={18} />
          <div>
            <p className="font-semibold">This is a deployment prerequisite</p>
            <p className="mt-1">
              The browser cannot complete this step by itself with the current
              API contract.
            </p>
          </div>
        </Alert>
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal size={17} className="text-primary" /> Supported local
              path
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm leading-6">
              Follow the root README for the supported installer or local
              development path. PostgreSQL starts before the API, Alembic
              applies the schema, and the identity bootstrap creates the first
              administrator.
            </p>
            <pre className="bg-muted text-foreground mt-4 overflow-x-auto rounded-md p-4 text-xs leading-6">
              # Follow the platform setup guide for your installation # or
              development environment.
            </pre>
            <p className="text-muted-foreground mt-4 text-sm leading-6">
              The installer creates the first administrator during setup. For
              local development, use the documented bootstrap workflow, then
              return here to sign in.
            </p>
          </CardContent>
        </Card>
        <div className="mt-9">
          <Button asChild size="lg">
            <a href="/login">
              Continue to sign in <ArrowRight aria-hidden="true" />
            </a>
          </Button>
        </div>
      </div>
    </main>
  );
}
