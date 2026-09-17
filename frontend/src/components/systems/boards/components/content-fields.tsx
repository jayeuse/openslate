"use client";

import { useId, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Download, ExternalLink, FileText, Link2, Plus, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { SearchSelect } from "@/components/ui/search-select";
import {
  localAttachmentUrl,
  releaseLocalAttachment,
} from "../../shared/runtime/local-attachments";
import type { SampleRecord } from "../../shared/data/sample-data";
import type {
  BoardAttachment,
  BoardAudience,
  BoardLink,
} from "../domain/model";
import {
  admitBoardFiles,
  cacheBoardAttachment,
  safeBoardUrl,
} from "../adapters/files";

export type BoardPerson = {
  id: string;
  name: string;
  role: string;
  departments: string[];
  active: boolean;
};

export function AudienceField({
  value,
  onChange,
  people,
  roles,
  departments,
  disabled = false,
}: {
  value: BoardAudience;
  onChange: (value: BoardAudience) => void;
  people: readonly BoardPerson[];
  roles: readonly { id: string; name: string }[];
  departments: readonly string[];
  disabled?: boolean;
}) {
  const options = [
    { value: "everyone", label: "Everyone on this board" },
    { value: "private", label: "Only the author" },
    ...roles.map((role) => ({
      value: `role:${role.id}`,
      label: `Role · ${role.name}`,
    })),
    ...departments.map((department) => ({
      value: `department:${department.toLowerCase().replaceAll(" ", "-")}`,
      label: `Department · ${department}`,
    })),
    ...people
      .filter((person) => person.active)
      .map((person) => ({
        value: `identity:${person.id}`,
        label: person.name,
      })),
  ];
  const selected =
    value.kind === "private" && value.unresolved
      ? "unresolved"
      : "id" in value
        ? `${value.kind}:${value.id}`
        : value.kind;
  return (
    <div className="flex flex-col gap-2">
      <SearchSelect
        label="Audience"
        value={selected}
        options={options}
        disabled={disabled}
        placeholder="Choose an available audience"
        onValueChange={(next) => {
          const [kind, ...rest] = next.split(":");
          if (kind === "everyone" || kind === "private") onChange({ kind });
          else if (
            kind === "role" ||
            kind === "identity" ||
            kind === "department"
          )
            onChange({ kind, id: rest.join(":") });
        }}
      />
      <p className="text-muted-foreground text-xs">
        Recipients must also have access to this board.
      </p>
    </div>
  );
}

export function ContentFields({
  attachments,
  originalAttachments,
  links,
  onChange,
  records,
  disabled = false,
}: {
  attachments: BoardAttachment[];
  originalAttachments: readonly BoardAttachment[];
  links: BoardLink[];
  onChange: (patch: {
    attachments?: BoardAttachment[];
    links?: BoardLink[];
  }) => void;
  records: readonly SampleRecord[];
  disabled?: boolean;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  return (
    <FieldSet disabled={disabled}>
      <FieldLegend>Supporting information</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-files`}>Files</FieldLabel>
          <Input
            id={`${id}-files`}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv"
            disabled={disabled}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (!files.length) return;
              const result = admitBoardFiles(files, attachments);
              if (!result.ok) setError(result.error);
              else {
                const added = result.attachments.slice(attachments.length);
                try {
                  added.forEach((file, index) =>
                    cacheBoardAttachment(file.id, files[index]),
                  );
                  setError("");
                  onChange({ attachments: result.attachments });
                } catch {
                  added.forEach((file) => releaseLocalAttachment(file.id));
                  setError(
                    "These files could not be opened in this tab. Choose them again.",
                  );
                }
              }
              event.target.value = "";
            }}
          />
          <FieldDescription>
            Up to 5 files, 10 MiB each. Files stay in this tab and need
            reattaching after a reload.
          </FieldDescription>
        </Field>
        {attachments.length > 0 && (
          <div className="flex flex-col gap-2">
            {attachments.map((file) => (
              <Attachment
                key={file.id}
                className="w-full"
                state={localAttachmentUrl(file.id) ? "done" : "error"}
              >
                <AttachmentMedia>
                  <FileText />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.name}</AttachmentTitle>
                  <AttachmentDescription>
                    {localAttachmentUrl(file.id)
                      ? `${Math.ceil(file.size / 1024)} KiB · not uploaded`
                      : "Unavailable after reload — remove and reattach"}
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${file.name}`}
                    disabled={disabled}
                    className="size-11"
                    onClick={() => {
                      if (
                        !originalAttachments.some(
                          (original) => original.id === file.id,
                        )
                      )
                        releaseLocalAttachment(file.id);
                      onChange({
                        attachments: attachments.filter(
                          (item) => item.id !== file.id,
                        ),
                      });
                    }}
                  >
                    <X />
                  </Button>
                </AttachmentActions>
              </Attachment>
            ))}
          </div>
        )}
        <SearchSelect
          label="Add a record link"
          value=""
          placeholder="Find a service request"
          disabled={disabled || links.length >= 20}
          options={records
            .filter(
              (record) => !links.some((link) => link.recordId === record.id),
            )
            .map((record) => ({ value: record.id, label: record.title }))}
          onValueChange={(recordId) => {
            const record = records.find((item) => item.id === recordId);
            if (record)
              onChange({
                links: [
                  ...links,
                  {
                    id: `board-link-${crypto.randomUUID()}`,
                    recordId,
                    label: record.title,
                    url: `/openview?record=${encodeURIComponent(recordId)}`,
                  },
                ],
              });
          }}
        />
        <Field>
          <FieldLabel htmlFor={`${id}-url`}>External link</FieldLabel>
          <Input
            id={`${id}-url`}
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-label`}>Link label</FieldLabel>
          <Input
            id={`${id}-label`}
            placeholder="For example, supplier instructions"
            maxLength={100}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-fit"
          disabled={disabled || !url.trim() || links.length >= 20}
          onClick={() => {
            const safe = safeBoardUrl(url);
            if (!safe) {
              setError("Enter a complete https:// or http:// link.");
              return;
            }
            setError("");
            onChange({
              links: [
                ...links,
                {
                  id: `board-link-${crypto.randomUUID()}`,
                  url: safe,
                  label: label.trim() || new URL(safe).hostname,
                },
              ],
            });
            setUrl("");
            setLabel("");
          }}
        >
          <Plus />
          Add link
        </Button>
        {links.length > 0 && (
          <ul className="flex flex-col gap-2">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex min-w-0 items-center justify-between gap-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Link2 className="size-4 shrink-0" />
                  <span className="truncate">{link.label}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  aria-label={`Remove link ${link.label}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      links: links.filter((item) => item.id !== link.id),
                    })
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error && <Alert variant="destructive">{error}</Alert>}
      </FieldGroup>
    </FieldSet>
  );
}

export function ContentAttachments({
  attachments,
  links,
  records,
}: {
  attachments: readonly BoardAttachment[];
  links: readonly BoardLink[];
  records: readonly SampleRecord[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {attachments.map((file) => {
        const url = localAttachmentUrl(file.id);
        return (
          <Attachment
            key={file.id}
            className="w-full"
            state={url ? "done" : "error"}
          >
            <AttachmentMedia
              variant={
                url &&
                ["image/png", "image/jpeg", "image/webp"].includes(file.type)
                  ? "image"
                  : "icon"
              }
            >
              {url &&
              ["image/png", "image/jpeg", "image/webp"].includes(file.type) ? (
                <Image
                  src={url}
                  alt={file.name}
                  width={80}
                  height={80}
                  unoptimized
                />
              ) : (
                <FileText />
              )}
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{file.name}</AttachmentTitle>
              <AttachmentDescription>
                {url
                  ? `${Math.ceil(file.size / 1024)} KiB · not uploaded`
                  : "File unavailable in this tab"}
              </AttachmentDescription>
            </AttachmentContent>
            {url && (
              <AttachmentActions>
                <Button variant="ghost" size="icon" className="size-11" asChild>
                  <a
                    href={url}
                    download={file.name}
                    aria-label={`Download ${file.name}`}
                  >
                    <Download />
                  </a>
                </Button>
              </AttachmentActions>
            )}
          </Attachment>
        );
      })}
      {links.map((link) => {
        const record = link.recordId
          ? records.find((item) => item.id === link.recordId)
          : null;
        const url = link.recordId
          ? record
            ? `/openview?record=${encodeURIComponent(record.id)}`
            : null
          : safeBoardUrl(link.url);
        const content = (
          <>
            <span className="truncate">{record?.title ?? link.label}</span>
            <ExternalLink className="size-3 shrink-0" />
          </>
        );
        const className =
          "focus-visible:outline-ring inline-flex w-fit max-w-full items-center gap-2 rounded-sm text-sm underline underline-offset-4";
        if (record)
          return (
            <Link
              key={link.id}
              href={`/openview?record=${encodeURIComponent(record.id)}`}
              className={className}
            >
              {content}
            </Link>
          );
        return url ? (
          <a
            key={link.id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={className}
          >
            {content}
          </a>
        ) : (
          <p key={link.id} className="text-muted-foreground text-sm">
            Linked item unavailable
          </p>
        );
      })}
    </div>
  );
}
