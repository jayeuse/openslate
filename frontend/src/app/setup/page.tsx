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
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal size={17} className="text-primary" /> Supported local
              path
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm leading-6">
              Follow the root README for environment setup, then run these
              commands from the repository root and backend directory. Supabase
              starts the local platform; Alembic applies the schema; the
              provisioning script creates the runtime login; and the bootstrap
              script sends the invitation.
            </p>
            <pre className="mt-4 overflow-x-auto rounded-md bg-slate-950 p-4 text-xs leading-6 text-slate-200">
              supabase start{`\n`}
              cd backend{`\n`}
              uv sync --locked{`\n`}
              uv run alembic upgrade head{`\n`}
              uv run python scripts/provision_database_role.py{`\n`}
              uv run python scripts/bootstrap_admin.py \{`\n`} --email
              &lt;email&gt; \{`\n`} --username &lt;username&gt;
            </pre>
            <p className="text-muted-foreground mt-4 text-sm leading-6">
              Open the invitation in local Mailpit to set the password, then
              return to sign in. The required bootstrap inputs are an email and
              username; there is no browser-side password bootstrap variable.
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
