import { Button } from "@/components/ui/button";

type EmptyCanvasPanelProps = {
  pending: boolean;
  onStartFromTemplate: () => void;
  onAddDepartment: () => void;
};

/**
 * The one first-run prompt of an empty design. It sits on the canvas, where
 * the structure will appear, and offers the two ways to start.
 */
export function EmptyCanvasPanel({
  pending,
  onStartFromTemplate,
  onAddDepartment,
}: EmptyCanvasPanelProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-4">
      <section
        data-slot="card"
        aria-labelledby="sandbox-empty-canvas-title"
        className="bg-card border-card-edge pointer-events-auto flex w-full max-w-md flex-col gap-4 rounded-xl border p-5 shadow-sm sm:p-6"
      >
        <EmptyCanvasSketch />
        <div className="flex flex-col gap-1.5">
          <h2
            data-slot="section-title"
            id="sandbox-empty-canvas-title"
            className="text-base font-semibold tracking-tight"
          >
            Design your organization
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Departments group the modules each team fills in. Start from a
            ready-made template, or add departments one at a time.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            className="whitespace-nowrap max-sm:min-h-11"
            disabled={pending}
            onClick={onStartFromTemplate}
          >
            Start from a template
          </Button>
          <Button
            variant="outline"
            className="whitespace-nowrap max-sm:min-h-11"
            disabled={pending}
            onClick={onAddDepartment}
          >
            Add your first department
          </Button>
        </div>
      </section>
    </div>
  );
}

/** A department frame holding two linked module tables, drawn in tokens. */
function EmptyCanvasSketch() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 48"
      className="h-12 w-[120px] self-start"
      fill="none"
    >
      <rect
        x="1"
        y="1"
        width="118"
        height="46"
        rx="6"
        stroke="var(--rule-strong)"
        strokeDasharray="3 3"
      />
      <rect
        x="10"
        y="11"
        width="38"
        height="26"
        rx="3"
        fill="var(--surface)"
        stroke="var(--rule-strong)"
      />
      <rect
        x="10"
        y="11"
        width="38"
        height="7"
        rx="3"
        fill="var(--action-tint)"
      />
      <path d="M16 25h24M16 31h16" stroke="var(--rule-strong)" />
      <rect
        x="72"
        y="11"
        width="38"
        height="26"
        rx="3"
        fill="var(--surface)"
        stroke="var(--rule-strong)"
      />
      <rect
        x="72"
        y="11"
        width="38"
        height="7"
        rx="3"
        fill="var(--action-tint)"
      />
      <path d="M78 25h24M78 31h16" stroke="var(--rule-strong)" />
      <path d="M48 24h24" stroke="var(--action)" strokeWidth="1.5" />
      <circle cx="72" cy="24" r="2" fill="var(--action)" />
    </svg>
  );
}
