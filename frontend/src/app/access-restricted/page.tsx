import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AccessRestrictedPage() {
  return (
    <main className="bg-background grid min-h-screen place-items-center px-6">
      <div className="max-w-md text-center">
        <div className="bg-accent text-accent-foreground mx-auto grid size-14 place-items-center rounded-full">
          <LockKeyhole />
        </div>
        <h1 className="mt-6 text-2xl font-semibold">
          Administrator access required
        </h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          Your account is authenticated, but the current API authorizes
          operational data for the exact admin role only. Ask an administrator
          to update the backend authorization model.
        </p>
        <Button asChild className="mt-6">
          <a href="/login">Return to sign in</a>
        </Button>
      </div>
    </main>
  );
}
