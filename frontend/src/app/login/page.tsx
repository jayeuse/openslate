"use client";

import { useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { useRouter } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setSession } from "@/lib/session";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const response = await fetch("/session/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const detail =
          typeof body === "object" &&
          body !== null &&
          "detail" in body &&
          typeof body.detail === "string"
            ? body.detail
            : "Sign in failed";
        throw new Error(detail);
      }
      setSession({ accessToken: "", refreshToken: "", username });
      router.push("/workspace");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in failed");
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="grid min-h-screen lg:grid-cols-[0.9fr_1.1fr]">
      <section className="bg-sidebar text-sidebar-foreground hidden p-10 lg:flex lg:flex-col lg:justify-between">
        <div>
          <a href="/" className="flex items-center gap-3">
            <span className="bg-primary text-primary-foreground grid size-9 place-items-center rounded-md text-sm font-bold">
              OS
            </span>
            <span className="font-semibold tracking-[0.14em] uppercase">
              OpenSlate
            </span>
          </a>
          <div className="mt-32 max-w-md">
            <p className="text-sidebar-muted text-xs font-semibold tracking-[0.18em] uppercase">
              Operations workspace
            </p>
            <h1 className="mt-5 text-5xl leading-tight font-semibold tracking-[-0.04em]">
              A clear view of what comes next.
            </h1>
            <p className="text-sidebar-muted mt-6 leading-7">
              Design your operating model once, then keep every team working
              from the same source of truth.
            </p>
          </div>
        </div>
        <p className="text-sidebar-muted text-xs">
          Self-hosted by default · OpenSlate
        </p>
      </section>
      <section className="bg-background flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <a
            href="/"
            className="mb-12 inline-flex items-center gap-2 text-sm font-semibold lg:hidden"
          >
            <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-md text-xs">
              OS
            </span>
            OpenSlate
          </a>
          <div className="mb-8">
            <div className="bg-accent text-accent-foreground mb-5 grid size-11 place-items-center rounded-full">
              <LockKeyhole size={20} />
            </div>
            <h2 className="text-2xl font-semibold">Welcome back</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              Sign in to continue to your workspace.
            </p>
          </div>
          {error && (
            <Alert variant="destructive" className="mb-5">
              {error}
            </Alert>
          )}
          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                minLength={12}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Use the credentials provisioned for your administrator account.
              </p>
            </div>
            <Button className="w-full" size="lg" disabled={pending}>
              {pending ? (
                "Signing in…"
              ) : (
                <>
                  Sign in <ArrowRight aria-hidden="true" />
                </>
              )}
            </Button>
          </form>
          <p className="text-muted-foreground mt-8 text-center text-sm">
            First deployment?{" "}
            <a
              className="text-primary font-medium hover:underline"
              href="/setup"
            >
              Read the setup guide
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
