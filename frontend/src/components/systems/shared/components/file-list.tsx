"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatFileSize, type FileDetails } from "../adapters/files-api";

export type FileListItem = Pick<
  FileDetails,
  "id" | "filename" | "expectedSize" | "actualSize"
>;

type FileListProps<T extends FileListItem> = {
  items: readonly T[];
  adapter: { download: (file: T) => void };
  downloadingId: string | null;
  label?: string;
  metadata?: (file: T) => ReactNode;
  secondaryAction?: {
    label: string;
    disabled: boolean;
    run: (file: T) => void;
  };
};

export function FileList<T extends FileListItem>({
  items,
  adapter,
  downloadingId,
  label = "Attached files",
  metadata,
  secondaryAction,
}: FileListProps<T>) {
  return (
    <ul aria-label={label} className="flex min-w-0 flex-col gap-2">
      {items.map((file) => (
        <li
          key={file.id}
          className="border-border flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
        >
          <span className="min-w-0 text-sm break-words">
            {file.filename}{" "}
            <span className="text-muted-foreground">
              ({formatFileSize(file.actualSize ?? file.expectedSize)})
            </span>
            {metadata ? (
              <span className="text-muted-foreground mt-1 block text-xs">
                {metadata(file)}
              </span>
            ) : null}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={downloadingId !== null}
              onClick={() => adapter.download(file)}
            >
              {downloadingId === file.id ? (
                "Downloading…"
              ) : (
                <>
                  Download
                  <span className="sr-only"> {file.filename}</span>
                </>
              )}
            </Button>
            {secondaryAction ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={secondaryAction.disabled}
                onClick={() => secondaryAction.run(file)}
              >
                {secondaryAction.label}
                <span className="sr-only"> {file.filename}</span>
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
