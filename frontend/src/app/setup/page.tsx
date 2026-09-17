import { ArrowRight, CircleAlert, Terminal } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
              Follow the root README for environment setup, then run these
              commands from the repository root and backend directory. Supabase
              starts the local platform; Alembic applies the schema; the
              provisioning script creates the runtime login; and the bootstrap
              script reads the administrator settings and sends the invitation.
            </p>
            <pre className="bg-muted text-foreground mt-4 overflow-x-auto rounded-md p-4 text-xs leading-6">
              # Set ADMIN_EMAIL, ADMIN_USERNAME, and ADMIN_PASSWORD{"\n"}# in
              the repository root .env file{"\n"}
              supabase start{"\n"}
              cd backend{"\n"}
              uv sync --locked{"\n"}
              uv run alembic upgrade head{"\n"}
              uv run python scripts/provision_database_role.py{"\n"}
              uv run python scripts/bootstrap_admin.py
            </pre>
            <p className="text-muted-foreground mt-4 text-sm leading-6">
              The bootstrap script reads <code>ADMIN_EMAIL</code> and{" "}
              <code>ADMIN_USERNAME</code> from the root <code>.env</code> file.{" "}
              <code>ADMIN_PASSWORD</code> must also be present for backend
              configuration validation, but it is not used to create or set the
              account password. Open the invitation in local Mailpit to choose
              the password, then return to sign in. For non-local environments,
              append <code>--confirm</code> to the bootstrap command.
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
