"use client";

import Link from "next/link";
import { ArrowUpRight, Files as FilesIcon } from "lucide-react";
import { SearchField } from "@/components/ui/search-field";
import { Action, Panel } from "../../shared/components/ui";
import type { SampleRecord } from "../../shared/data/sample-data";
import type { PlatformFile } from "../domain/model";

type FilesProps = {
  files: readonly PlatformFile[];
  records: readonly SampleRecord[];
  fileQuery: string;
  onFileQueryChange: (query: string) => void;
  file: PlatformFile | undefined;
  navigationPending: boolean;
  isNavigationPending: () => boolean;
  onOpenFile: (fileId: string) => void;
  onCloseDetails: () => void;
};

export default function Files({
  files,
  records,
  fileQuery,
  onFileQueryChange,
  file,
  navigationPending,
  isNavigationPending,
  onOpenFile,
  onCloseDetails,
}: FilesProps) {
  const matchingFiles = files.filter((item) =>
    item.name.toLowerCase().includes(fileQuery.toLowerCase()),
  );

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel title="Central file library">
        <SearchField
          label="Search files by name"
          value={fileQuery}
          onValueChange={onFileQueryChange}
          placeholder="Find a file…"
        />
        {matchingFiles.map((item) => (
          <button
            key={item.id}
            className="hover:bg-muted flex min-h-16 w-full items-center gap-3 rounded-lg border p-4 text-left"
            disabled={navigationPending}
            onClick={(event) => {
              if (isNavigationPending()) {
                event.preventDefault();
                return;
              }
              onOpenFile(item.id);
            }}
          >
            <FilesIcon className="size-5 shrink-0" />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm">{item.name}</strong>
              <span className="text-muted-foreground text-xs">
                {item.type} · {item.size}
              </span>
            </span>
            <ArrowUpRight className="size-4" />
          </button>
        ))}
        {!matchingFiles.length && (
          <p className="text-muted-foreground text-sm">
            No files match your search.
          </p>
        )}
      </Panel>
      <Panel title="File details">
        {file ? (
          <>
            <p className="font-medium break-words">{file.name}</p>
            <p className="text-muted-foreground text-sm">
              Example attachment metadata. No real file was uploaded.
            </p>
            <h3 data-slot="section-title" className="text-sm font-medium">
              Attached to
            </h3>
            <Link
              className="block min-h-11 rounded-lg border p-3 text-sm underline"
              href={`/openview?record=${encodeURIComponent(file.recordId)}`}
            >
              {records.find((record) => record.id === file.recordId)?.title ??
                "Service job"}
            </Link>
            <Action
              disabled={navigationPending}
              onClick={() => {
                if (isNavigationPending()) return;
                onCloseDetails();
              }}
            >
              Close details
            </Action>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            Select a file to see its record reference.
          </p>
        )}
      </Panel>
    </div>
  );
}
