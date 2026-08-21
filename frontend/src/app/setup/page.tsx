import { ArrowRight, CircleAlert, Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SetupPage() {
  return (
    <main className="bg-background min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
        <a href="/" className="flex items-center gap-3">
          <span className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-md text-sm font-bold">
            OS
          </span>
          <span className="text-sm font-semibold tracking-[0.16em] uppercase">
            OpenSlate
          </span>
        </a>
        <Button asChild variant="ghost">
          <a href="/login">Back to sign in</a>
        </Button>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-14 sm:py-24">
        <p className="text-primary text-xs font-semibold tracking-[0.18em] uppercase">
          First deployment
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
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
        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal size={17} className="text-primary" /> Docker Compose
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm leading-6">
                Set both bootstrap variables in your root environment file
                before starting the stack.
              </p>
              <pre className="mt-4 overflow-x-auto rounded-md bg-slate-950 p-4 text-xs leading-6 text-slate-200">
                ADMIN_BOOTSTRAP_USERNAME=admin{`\n`}
                ADMIN_BOOTSTRAP_PASSWORD=your-12-character-password
              </pre>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Local command</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm leading-6">
                Run the existing one-time bootstrap script from the backend
                directory.
              </p>
              <pre className="mt-4 overflow-x-auto rounded-md bg-slate-950 p-4 text-xs leading-6 text-slate-200">
                uv run python -m scripts.bootstrap_admin \{`\n`} --username
                admin
              </pre>
            </CardContent>
          </Card>
        </div>
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
