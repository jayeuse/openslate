import type { ReactNode } from "react";

export type DialogRow = {
  label: string;
  /** A real `<label for>` when the value is a control. */
  htmlFor?: string;
  value: ReactNode;
};

/**
 * Label-left rows inside a framed Account settings dialog (comp
 * `settings.html`): a 136px muted label column from 640px; phones stack the
 * label above the field.
 */
export function DialogRows({ rows }: { rows: DialogRow[] }) {
  return (
    <div className="grid min-w-0 gap-2.5">
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid min-w-0 gap-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-start sm:gap-x-4"
        >
          {row.htmlFor ? (
            <label
              htmlFor={row.htmlFor}
              className="sm:text-muted-foreground text-sm sm:flex sm:min-h-11 sm:items-center xl:min-h-8"
            >
              {row.label}
            </label>
          ) : (
            <span className="sm:text-muted-foreground text-sm sm:flex sm:min-h-11 sm:items-center xl:min-h-8">
              {row.label}
            </span>
          )}
          <div className="grid min-w-0 gap-1.5 sm:min-h-11 sm:items-center xl:min-h-8">
            {row.value}
          </div>
        </div>
      ))}
    </div>
  );
}
