"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { apiErrorReference, type ApiErrorText } from "@/lib/api-errors";
import { requestSessionRecheck } from "@/lib/auth-api";
import type { ReferenceViewer } from "@/lib/reference-viewer";

import {
  downloadInstallationDiagnostics,
  downloadOrganizationDiagnostics,
  type DiagnosticsFile,
} from "../adapters/system-diagnostics-api";

// D19.2: what the file holds, by viewer.
const PARAGRAPHS: Readonly<Record<Exclude<ReferenceViewer, "member">, string>> =
  {
    admin:
      "A support file helps the person who runs your server find a problem. It lists the versions, the last 30 days of the parts, your organization's file storage, and its recent server errors with their references. It holds no records, no personal data and nothing from other organizations.",
    owner:
      "A support file helps whoever supports your installation find a problem. It lists the versions, the database size, the background workers, each organization's file storage, 30 days of checks, and recent server errors with their references. It holds no records and no personal data.",
  };

const PREPARING_DELAY_MS = 300;
const DOWNLOADED_FOR_MS = 4_000;

/** A failed download as block 6 words it (D19.4); null for a refused session. */
export function supportFileFailure(error: unknown): ApiErrorText | null {
  if (error instanceof ApiError && error.status === 401) return null;
  // The role changed after the page loaded: a refusal notice, no reference.
  if (error instanceof ApiError && error.status === 403)
    return {
      message: "Only an administrator can download a support file.",
      reference: undefined,
    };
  if (error instanceof TypeError)
    return {
      message: "Could not connect. Check your connection and try again.",
      reference: undefined,
    };
  return {
    message: "The support file could not be prepared. Try again in a minute.",
    reference: apiErrorReference(error),
  };
}

/** Saves the bytes under the server's name, as the Audit CSV download does. */
function saveFile({ blob, filename }: DiagnosticsFile): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * "Download support file" in block 6 (S6-C2 to S6-C4, D19): the installation
 * owner's file, or an organization admin's file for their organization.
 * Members and guests, and a page whose identity has not loaded, get nothing.
 * A fetch with the session, then a save, so a failure can show its message
 * and reference.
 */
export function SupportFile({ viewer }: { viewer: ReferenceViewer }) {
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<ApiErrorText | null>(null);
  const running = useRef(false);
  const timers = useRef(new Set<number>());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
      abort.current?.abort();
    };
  }, []);
  if (viewer === "member") return null;
  // D19.2: the owner gets the installation file only, also as an admin.
  const downloadFile =
    viewer === "owner"
      ? downloadInstallationDiagnostics
      : downloadOrganizationDiagnostics;

  const later = (run: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, delay);
    timers.current.add(timer);
    return timer;
  };
  const clearTimers = () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current.clear();
  };

  async function download() {
    if (running.current) return;
    running.current = true;
    clearTimers();
    setFailure(null);
    setAnnouncement("");
    setBusy(true);
    // A fast download shows nothing.
    later(
      () => setAnnouncement("Preparing the support file…"),
      PREPARING_DELAY_MS,
    );
    const controller = new AbortController();
    abort.current = controller;
    try {
      const file = await downloadFile(controller.signal);
      if (controller.signal.aborted) return;
      clearTimers();
      saveFile(file);
      setAnnouncement("Support file downloaded.");
      later(() => setAnnouncement(""), DOWNLOADED_FOR_MS);
    } catch (error) {
      if (controller.signal.aborted) return;
      clearTimers();
      setAnnouncement("");
      setFailure(supportFileFailure(error));
      // The paragraph and the button go at the next identity read.
      if (error instanceof ApiError && error.status === 403)
        queueMicrotask(requestSessionRecheck);
    } finally {
      if (!controller.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <SupportFileView
      viewer={viewer}
      busy={busy}
      announcement={announcement}
      failure={failure}
      onDownload={() => void download()}
    />
  );
}

/** Paragraph 3, the button, its status span and its Alert (D19.1 to D19.4). */
export function SupportFileView({
  viewer,
  busy,
  announcement,
  failure,
  onDownload,
}: {
  viewer: ReferenceViewer;
  busy: boolean;
  announcement: string;
  failure: ApiErrorText | null;
  onDownload: () => void;
}) {
  if (viewer === "member") return null;
  return (
    <>
      <p>{PARAGRAPHS[viewer]}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* A focused button that turns disabled loses focus, so a running
            download uses aria-disabled and ignores presses (D2.4). */}
        <Button
          type="button"
          variant="outline"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          className="min-h-11 xl:min-h-8"
          onClick={() => {
            if (!busy) onDownload();
          }}
        >
          <Download aria-hidden="true" />
          Download support file
        </Button>
        <span role="status" className="text-muted-foreground text-sm">
          {announcement}
        </span>
      </div>
      {failure ? (
        <Alert role="alert" variant="destructive" reference={failure.reference}>
          <p>{failure.message}</p>
        </Alert>
      ) : null}
    </>
  );
}
