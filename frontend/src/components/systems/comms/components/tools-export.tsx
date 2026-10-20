"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelectOption } from "@/components/ui/native-select";
import { Choice, Toggle } from "../../shared/components/ui";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import { complete } from "../state/workspace-view";
import {
  messageFromCommsError,
  useCommsCommands,
  useCommsRead,
} from "../state/runtime";
import { ConfigurationFrame } from "./configuration-frame";
import { ToolAdvanced } from "./tool-advanced";
import { TextField } from "./message-shared";
import type { CommsToolsDialogProps } from "./tools-dialog";

export function ExportTools({
  embedded,
  channelId,
  opener,
  onClose,
}: CommsToolsDialogProps) {
  const { bootstrap, checks } = useCommsWorkspaceView();
  const { run, isPending } = useCommsCommands();
  const rooms = bootstrap?.conversations.map((row) => row.conversation) ?? [];
  const privateRoom = (id: string) =>
    rooms.some(
      (room) =>
        room.id === id && (room.kind !== "channel" || room.scope === "members"),
    );
  const [selected, setSelected] = useState<string[]>(
    channelId && !privateRoom(channelId) ? [channelId] : [],
  );
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const allowed = Object.values(checks).some(
    (check) => check.capabilities.manageWorkspace.allowed,
  );
  const protectedSelection = selected.some(privateRoom);
  const resource = useCommsRead("exports", (client, signal) =>
    complete((offset) =>
      client.listExports({ limit: 100, offset }, { signal }),
    ),
  );
  async function start() {
    setError("");
    try {
      await run("export-start", (client, signal) =>
        client.startExport(
          {
            conversation_ids: selected,
            format,
            ...(after ? { after } : {}),
            ...(before ? { before } : {}),
            ...(protectedSelection ? { reason: reason.trim() } : {}),
          },
          {
            signal,
            ...(protectedSelection && confirmed
              ? { password: "CONFIRM LOCAL SAMPLE" }
              : {}),
          },
        ),
      );
      resource.reload();
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The export could not be started. Your choices are still here.",
        ),
      );
    }
  }
  async function download(id: string) {
    setError("");
    try {
      const file = await run(`export-download:${id}`, (client, signal) =>
        client.downloadExport(id, { signal }),
      );
      const url = URL.createObjectURL(file.bytes);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = file.filename;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The sample export is unavailable. Start a new export.",
        ),
      );
    }
  }
  function choices(privateSources: boolean) {
    return rooms
      .filter((room) => privateRoom(room.id) === privateSources)
      .map((room) => (
        <Field key={room.id} className="flex-row items-center gap-3">
          <Checkbox
            id={`export-source-${room.id}`}
            checked={selected.includes(room.id)}
            disabled={!allowed || isPending()}
            onCheckedChange={(checked) => {
              setSelected((ids) =>
                checked
                  ? [...ids, room.id]
                  : ids.filter((id) => id !== room.id),
              );
              setConfirmed(false);
            }}
          />
          <FieldLabel
            htmlFor={`export-source-${room.id}`}
            className="min-h-11 flex-1 font-normal"
          >
            {room.kind === "channel"
              ? `#${room.name}`
              : room.kind === "group"
                ? room.name
                : "Direct conversation"}
          </FieldLabel>
        </Field>
      ));
  }
  return (
    <ConfigurationFrame
      embedded={embedded}
      className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
      title="Export messages"
      opener={opener}
      onClose={onClose}
    >
      <FieldGroup className="p-5 sm:p-6">
        <p className="text-muted-foreground text-sm">
          This local example records your format and dates but downloads fixed
          sample CSV bytes, not message data or an XLSX workbook. Export bytes
          do not survive a page reload.
        </p>
        {(error || resource.error || !allowed) && (
          <Alert role="alert" variant="destructive">
            {error ||
              (allowed
                ? "Exports could not be loaded."
                : "Only organization administrators can export.")}
            {resource.error && (
              <Button onClick={resource.reload}>Try again</Button>
            )}
          </Alert>
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Channels</legend>
          {choices(false)}
        </fieldset>
        <Choice
          label="Export format"
          value={format}
          onChange={(event) =>
            setFormat(event.target.value === "xlsx" ? "xlsx" : "csv")
          }
        >
          <NativeSelectOption value="csv">CSV</NativeSelectOption>
          <NativeSelectOption value="xlsx">
            XLSX request (sample CSV download)
          </NativeSelectOption>
        </Choice>
        <TextField
          label="From date"
          type="date"
          value={after}
          onChange={(event) => setAfter(event.target.value)}
        />
        <TextField
          label="Before date"
          type="date"
          value={before}
          onChange={(event) => setBefore(event.target.value)}
        />
        {protectedSelection && (
          <p role="status">
            Private sources selected. An administrator reason and sample
            confirmation are required.
          </p>
        )}
        <Button
          onClick={() => void start()}
          disabled={
            !allowed ||
            isPending() ||
            !selected.length ||
            (protectedSelection && (!reason.trim() || !confirmed))
          }
        >
          Start export
        </Button>
        {resource.data?.map((job) => (
          <section
            key={job.id}
            aria-label="Export job"
            className="flex flex-wrap items-center gap-3 border-t py-3"
          >
            <p className="text-sm">
              Requested {job.request.format.toUpperCase()} · {job.status}
            </p>
            {job.status === "succeeded" && (
              <Button
                variant="outline"
                disabled={isPending()}
                onClick={() => void download(job.id)}
              >
                Download sample CSV
              </Button>
            )}
          </section>
        ))}
        <ToolAdvanced tool="export">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">
              Private channels and direct messages
            </legend>
            {choices(true)}
          </fieldset>
          <TextField
            label="Recorded reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setConfirmed(false);
            }}
          />
          <Toggle
            label="Confirm sample operation — local example data only; no account password required."
            checked={confirmed}
            onCheckedChange={setConfirmed}
            disabled={!allowed}
          />
        </ToolAdvanced>
      </FieldGroup>
    </ConfigurationFrame>
  );
}
