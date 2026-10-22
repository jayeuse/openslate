"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SampleRecord } from "../../shared/data/sample-data";
import { recordContext } from "../domain/records";

export type RecordMention = {
  messageId: string;
  conversationName: string;
  author: string;
  text: string;
};

/** A linked record beside the conversation: its details, and where people
 *  talk about it. The record itself lives in OpenView. */
export function RecordPanel({
  record,
  mentions,
  onJump,
  onClose,
}: {
  record: SampleRecord;
  mentions: RecordMention[];
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const { module } = recordContext(record);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b px-4">
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="text-muted-foreground size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <path d="M2 6.5h12M6.5 6.5v7" />
        </svg>
        <span className="text-sm font-semibold">Record</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto min-h-11 min-w-11"
          aria-label="Close record"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 *:shrink-0">
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">{module}</p>
          <h3 className="font-heading text-xl leading-tight font-bold tracking-[-0.02em]">
            {record.title}
          </h3>
        </div>
        <dl className="border-card-edge overflow-hidden rounded-[calc(var(--radius)*1.25)] border text-sm">
          {record.fields?.map((field) => (
            <div
              key={field.id}
              className="even:bg-muted/40 flex justify-between gap-3 border-b px-3 py-2 last:border-b-0"
            >
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd
                className="min-w-0 text-right text-sm break-words whitespace-pre-wrap"
                dir="auto"
              >
                {field.displayValue}
              </dd>
            </div>
          ))}
        </dl>
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Mentioned in</h4>
          {mentions.length ? (
            <ul aria-label="Mentioned in" className="flex flex-col gap-1">
              {mentions.map((mention) => (
                <li key={mention.messageId}>
                  <button
                    type="button"
                    onClick={() => onJump(mention.messageId)}
                    className="hover:bg-muted focus-visible:outline-ring flex min-h-11 w-full flex-col gap-0.5 rounded-[var(--radius)] px-2 py-1.5 text-left outline-none focus-visible:outline-2"
                  >
                    <span className="text-xs font-semibold">
                      {mention.conversationName} · {mention.author}
                    </span>
                    <span className="text-muted-foreground line-clamp-2 text-xs">
                      {mention.text}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs">
              No conversation links this record yet.
            </p>
          )}
        </section>
        <Button asChild className="min-h-11">
          <Link href={`/openview?record=${encodeURIComponent(record.id)}`}>
            Open in OpenView
          </Link>
        </Button>
      </div>
    </div>
  );
}
