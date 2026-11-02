"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ErrorReferenceCopy = "idle" | "copied" | "failed";

// How long "Reference copied" stays before the slot empties again.
const COPIED_MILLISECONDS = 4000;

/**
 * The error reference of one failed request (R5 and D1, docs/specs/
 * system-health.md): "Reference" and the last eight characters of the request
 * ID, a Copy control that copies the full ID, and the sentence that says what
 * to do with it. Always the last part of its error container. With no ID it
 * renders nothing, not even an empty line.
 */
export function ErrorReference({
  id,
  className,
}: {
  id: string | null | undefined;
  className?: string;
}) {
  // The copy result belongs to one ID; a new error starts idle.
  const [result, setResult] = useState<{
    id: string;
    copy: ErrorReferenceCopy;
  } | null>(null);
  const copy = result && result.id === id ? result.copy : "idle";
  useEffect(() => {
    if (copy !== "copied") return;
    const timer = window.setTimeout(() => setResult(null), COPIED_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [copy]);
  if (!id) return null;
  return (
    <ErrorReferenceView
      id={id}
      copy={copy}
      className={className}
      onCopy={() => {
        const copied = navigator.clipboard?.writeText(id);
        if (!copied) {
          setResult({ id, copy: "failed" });
          return;
        }
        copied
          .then(() => setResult({ id, copy: "copied" }))
          .catch(() => setResult({ id, copy: "failed" }));
      }}
    />
  );
}

/** The reference as it shows for one copy state. */
export function ErrorReferenceView({
  id,
  copy,
  onCopy,
  className,
}: {
  id: string | null | undefined;
  copy: ErrorReferenceCopy;
  onCopy: () => void;
  className?: string;
}) {
  if (!id) return null;
  return (
    // Phrasing markup (spans shown as blocks), so the reference is valid
    // inside any error container, a <p> included.
    <span
      data-slot="error-reference"
      className={cn("text-foreground mt-2 block text-sm", className)}
    >
      {/* Wraps between its parts on a narrow width; the 8 characters never
          break. */}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>Reference</span>
        <code
          title={id}
          className="font-mono text-sm whitespace-nowrap tabular-nums"
        >
          {id.slice(-8)}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Copy reference"
          className="min-h-11 text-sm xl:min-h-8"
          onClick={onCopy}
        >
          <Copy aria-hidden="true" />
          Copy
        </Button>
        <span role="status">
          {copy === "copied"
            ? "Reference copied"
            : copy === "failed"
              ? "Copy failed. Select the reference below."
              : ""}
        </span>
      </span>
      <span className="block">Give this reference to your administrator.</span>
      {copy === "failed" ? (
        <span className="block">
          <code className="font-mono text-sm break-all select-all">{id}</code>
        </span>
      ) : null}
    </span>
  );
}
