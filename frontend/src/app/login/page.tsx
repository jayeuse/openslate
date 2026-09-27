"use client";

import { useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { useRouter } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field as FormField,
  FieldControl,
  FieldLabel,
} from "@/components/ui/field";
import { ApiError } from "@/lib/api";
import { signIn } from "@/lib/auth-api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const session = await signIn(email, password);
      if (session.setup_required) {
        setError("Finish setup using the link in your invitation email.");
        return;
      }
      router.push("/openview");
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 401
          ? "Invalid email or password."
          : "Unable to sign in. Check your connection and try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="grid min-h-screen lg:grid-cols-[0.9fr_1.1fr]">
      <section className="bg-sidebar text-sidebar-foreground hidden p-10 lg:flex lg:flex-col lg:justify-between">
        <div>
          <a href="/" className="flex items-center gap-3">
            <span className="bg-foreground text-background grid size-9 place-items-center rounded-md text-sm font-bold">
              OS
            </span>
            <span className="font-semibold">OpenSlate</span>
          </a>
          <div className="mt-32 max-w-md">
            <h1 className="mt-5 text-4xl leading-tight font-semibold tracking-[-0.04em]">
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
            <span className="bg-foreground text-background grid size-8 place-items-center rounded-md text-xs">
              OS
            </span>
            OpenSlate
          </a>
          <div className="mb-8">
            <div className="bg-muted text-muted-foreground mb-5 grid size-11 place-items-center rounded-full">
              <LockKeyhole size={20} />
            </div>
            <h2 className="text-2xl font-semibold">Welcome back</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              Sign in to continue to your workspace.
            </p>
          </div>
          {error && (
            <Alert role="alert" variant="destructive" className="mb-5">
              {error}
            </Alert>
          )}
          <form className="space-y-5" onSubmit={submit}>
            <FormField className="space-y-2">
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <FieldControl
                render={
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                }
              />
            </FormField>
            <FormField className="space-y-2">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <FieldControl
                render={
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    minLength={12}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                }
              />
              <p className="text-muted-foreground text-xs">
                Use the email and password for your OpenSlate account.
              </p>
              <a
                className="text-primary inline-block text-sm font-medium hover:underline"
                href="/auth/recovery"
              >
                Forgot password?
              </a>
            </FormField>
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
