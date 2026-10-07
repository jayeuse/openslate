"use client";

import { Upload } from "lucide-react";
import { useId, useRef, type ChangeEvent, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FilePickerButtonProps = {
  /** Visible button text, for example "Upload file" or "Choose logo". */
  children: ReactNode;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Name of the chosen file, shown beside the button. */
  selectedName?: string | null;
  /** Shown when nothing is chosen. Omit to show nothing. */
  emptyText?: string;
  id?: string;
  variant?: ButtonProps["variant"];
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  onFiles: (files: File[], event: ChangeEvent<HTMLInputElement>) => void;
};

/**
 * A designed button that opens the browser's file chooser. The native input
 * stays in the DOM (sr-only) so forms, labels and tests can still reach it.
 */
export function FilePickerButton({
  children,
  accept,
  multiple,
  disabled,
  selectedName,
  emptyText,
  id,
  variant = "outline",
  className,
  onFiles,
  ...aria
}: FilePickerButtonProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const status = selectedName ?? emptyText;

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <Button
        type="button"
        variant={variant}
        className="min-h-11 md:min-h-9"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden="true" />
        {children}
      </Button>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        tabIndex={-1}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []), event);
        }}
      />
      {status ? (
        <span
          className={cn(
            "min-w-0 text-sm break-words",
            selectedName ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      ) : null}
    </div>
  );
}
