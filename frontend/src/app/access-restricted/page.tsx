import type { Metadata } from "next";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Access restricted" };

export default function AccessRestrictedPage() {
  return (
    <main className="bg-background grid min-h-screen place-items-center px-6">
      <div className="max-w-md text-center">
        <div className="bg-accent text-accent-foreground mx-auto grid size-14 place-items-center rounded-full">
          <LockKeyhole />
        </div>
        <h1 className="mt-6 text-2xl font-semibold">Access restricted</h1>
        <p className="text-muted-foreground mt-3 text-sm leading-6">
          Your account is authenticated, but your role does not grant the
          capability required for this area. Ask an administrator to review your
          role permissions.
        </p>
        <Button asChild className="mt-6">
          <a href="/login">Return to sign in</a>
        </Button>
      </div>
    </main>
  );
}
