"use client";
import { useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace-provider";
import { FileUpload } from "@/components/files/file-upload";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import type { WorkspaceProfile } from "@/lib/workspace";
import {
  listFiles,
  canRetryScan,
  fileFailureMessage,
  fileAction,
  fileStateLabels,
  type ManagedFile,
} from "@/lib/files";
import { useFileRefresh } from "@/components/files/use-file-refresh";
export function WorkspaceLogoSettings({
  profile,
  onUpdated,
}: {
  profile: WorkspaceProfile;
  onUpdated: () => void | Promise<void>;
}) {
  const { isAdmin } = useWorkspace();
  const [candidate, setCandidate] = useState<ManagedFile | null>(null);
  const [candidates, setCandidates] = useState<ManagedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const { visible, generation, expired, refresh } = useFileRefresh(
    isAdmin,
    candidates.some((file) =>
      ["uploading", "pending_scan"].includes(file.state),
    ) || ["uploading", "pending_scan"].includes(candidate?.state ?? ""),
  );
  useEffect(() => {
    if (!isAdmin || !visible) return;
    const controller = new AbortController();
    void (async () => {
      const recovered: ManagedFile[] = [];
      let offset = 0;
      let more = true;
      while (more) {
        const result = await listFiles(
          "workspace_logo",
          undefined,
          offset,
          controller.signal,
        );
        recovered.push(...result.items);
        more = result.pagination.has_more;
        offset += 25;
      }
      if (controller.signal.aborted) return;
      const available = recovered.filter(
        (file) =>
          !file.is_deleted &&
          file.id !== profile.logo_file_id &&
          ["uploading", "pending_scan", "ready", "rejected"].includes(
            file.state,
          ),
      );
      setCandidates(available);
      setCandidate((current) =>
        current?.id === profile.logo_file_id
          ? null
          : current
            ? (recovered.find((file) => file.id === current.id) ?? current)
            : available.length === 1
              ? available[0]
              : null,
      );
    })().catch(() => {
      if (!controller.signal.aborted)
        setError("Logo candidates could not be refreshed.");
    });
    return () => controller.abort();
  }, [isAdmin, visible, generation, profile.logo_file_id]);
  if (!isAdmin) return null;
  async function save(id: string | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiFetch("/workspace", {
        method: "PATCH",
        body: JSON.stringify({ revision: profile.revision, logo_file_id: id }),
      });
      await onUpdated();
      setMessage(id ? "Workspace logo updated." : "Workspace logo removed.");
      setCandidate(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logo could not be updated.");
    } finally {
      setBusy(false);
    }
  }
  async function scan() {
    if (!candidate || busy) return;
    setBusy(true);
    setError("");
    try {
      setCandidate(await fileAction(candidate.id, "scan"));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scanning is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function reconcile() {
    if (!candidate || busy) return;
    setBusy(true);
    setError("");
    try {
      setCandidate(await fileAction(candidate.id, "reconcile"));
      refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Upload outcome remains unresolved.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace logo</CardTitle>
        <CardDescription>
          Your current logo stays in place until you choose a replacement that
          has passed scanning.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <FileUpload
          purpose="workspace_logo"
          onChange={(file) => {
            setCandidate(file);
            refresh();
          }}
          disabled={busy}
          onBusyChange={setBusy}
        />
        <Button
          variant="outline"
          className="self-start"
          onClick={refresh}
          disabled={busy}
        >
          Refresh logo status
        </Button>
        {expired && (
          <p role="status">
            Automatic status checks paused. Refresh logo status to check again.
          </p>
        )}
        {candidates.length > 1 && (
          <div className="flex flex-col gap-2">
            <label htmlFor="logo-candidate">Choose a logo candidate</label>
            <select
              id="logo-candidate"
              className="border-input bg-background rounded-md border p-2"
              value={candidate?.id ?? ""}
              onChange={(event) =>
                setCandidate(
                  candidates.find((file) => file.id === event.target.value) ??
                    null,
                )
              }
            >
              <option value="">Choose a candidate</option>
              {candidates.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.filename} · {fileStateLabels[file.state]}
                </option>
              ))}
            </select>
          </div>
        )}
        {candidate && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {candidate.filename} · {fileStateLabels[candidate.state]}
            </p>
            {candidate.failure_code && (
              <p role="status">{fileFailureMessage(candidate.failure_code)}</p>
            )}
            {canRetryScan(candidate) && (
              <Button
                className="self-start"
                variant="outline"
                disabled={busy}
                onClick={() => void scan()}
              >
                Retry scanning logo
              </Button>
            )}
            {candidate.state === "uploading" && (
              <Button
                className="self-start"
                variant="outline"
                disabled={busy}
                onClick={() => void reconcile()}
              >
                Reconcile upload
              </Button>
            )}
            <Button
              className="self-start"
              disabled={
                busy || candidate.state !== "ready" || candidate.is_deleted
              }
              onClick={() => void save(candidate.id)}
            >
              Use this logo
            </Button>
          </div>
        )}
        <Button
          variant="outline"
          className="self-start"
          disabled={busy}
          onClick={() => void save(null)}
        >
          Remove current logo
        </Button>
        {message && <p role="status">{message}</p>}
        {error && <Alert variant="destructive">{error}</Alert>}
      </CardContent>
    </Card>
  );
}
