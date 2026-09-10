"use client";
import { WorkspaceLogoSettings } from "@/components/workspace-logo-settings";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api";
import { isSupportedWorkspaceLocale } from "@/lib/date-time";
import { workspaceSchema, type WorkspaceProfile } from "@/lib/workspace";
const fields = [
  ["display_name", "Display name", 200],
  ["legal_name", "Legal name", 200],
  ["description", "Description", 2000],
  ["contact_email", "Contact email", 254],
  ["contact_phone", "Contact phone", 50],
  ["postal_address", "Postal address", 2000],
  ["timezone", "Timezone (IANA)", 100],
  ["locale", "Locale", 100],
] as const;
export default function WorkspaceSettingsPage() {
  const { profile, isAdmin, refresh } = useWorkspace();
  const [draft, setDraft] = useState<WorkspaceProfile>(profile);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  if (!isAdmin)
    return (
      <Alert variant="destructive">
        Administrator access is required to manage the workspace.
      </Alert>
    );
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const body = Object.fromEntries(
        fields.map(([key]) => [key, draft[key] || null]),
      );
      const response = await apiFetch<unknown>("/workspace", {
        method: "PATCH",
        body: JSON.stringify({ ...body, revision: draft.revision }),
      });
      const saved = workspaceSchema.parse(response);
      setDraft(saved);
      await refresh();
      setFailed(false);
      setMessage("Workspace saved.");
    } catch (reason) {
      setFailed(true);
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Workspace could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Workspace settings"
        description="Organization identity and regional formatting for everyone in this deployment."
      />
      {!isSupportedWorkspaceLocale(profile.locale) && (
        <Alert className="mt-5">
          The stored workspace locale is invalid. Dates use en-US until an
          administrator saves a supported locale.
        </Alert>
      )}
      {message && (
        <Alert variant={failed ? "destructive" : "default"}>{message}</Alert>
      )}
      {profile.revision !== draft.revision && (
        <Alert>
          The workspace changed while you were editing. Your draft is preserved.{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => setDraft(profile)}
          >
            Reload current settings
          </Button>
        </Alert>
      )}
      <form onSubmit={submit} className="mt-5 max-w-2xl">
        <FieldGroup>
          {fields.map(([key, label, max]) => (
            <Field key={key}>
              <FieldLabel htmlFor={key}>{label}</FieldLabel>
              <Input
                id={key}
                required={
                  key === "display_name" ||
                  key === "timezone" ||
                  key === "locale"
                }
                type={key === "contact_email" ? "email" : "text"}
                maxLength={max}
                value={draft[key] ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, [key]: event.target.value })
                }
              />
            </Field>
          ))}
          <p className="text-muted-foreground text-sm">
            Use an IANA timezone such as Asia/Manila and a locale such as en-US.
            Calendar dates keep their original day.
          </p>
          <Button disabled={pending || profile.revision !== draft.revision}>
            {pending ? "Saving…" : "Save workspace"}
          </Button>
        </FieldGroup>
      </form>
      <div className="mt-6 max-w-2xl">
        <WorkspaceLogoSettings profile={profile} onUpdated={refresh} />
      </div>
    </>
  );
}
