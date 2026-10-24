"use client";

import {
  cloneElement,
  useId,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ControlProps = {
  "aria-describedby"?: string;
  "aria-disabled"?: boolean | "true" | "false";
  disabled?: boolean;
  // Any element's click handler fits: MouseEvent<never> reaches every
  // element type.
  onClick?: (event: MouseEvent<never>) => void;
};

/**
 * A control that cannot act says why (the Four Moments Rule, DESIGN.md).
 * With a reason, the control stays focusable (`aria-disabled`, not
 * `disabled`), ignores activation, and shows the reason on hover, focus, and
 * tap; screen readers hear it as the control's description. Without a
 * reason, the control renders unchanged. When the reason is already visible
 * text, pass its id as `reasonId`: the control points at that text instead of
 * a hidden copy, so the reason is announced once.
 */
export function DisabledReason({
  reason,
  reasonId,
  stable = false,
  children,
}: {
  reason: string | null | undefined;
  reasonId?: string;
  /**
   * Keep the control mounted while its reason comes and goes, so a focused
   * control keeps focus when it starts or stops waiting (for example Save
   * while it saves). Without it, no reason renders the control unchanged.
   */
  stable?: boolean;
  children: ReactElement<ControlProps>;
}) {
  const id = useId();
  // Opened by a tap or click too: touch has no hover, and a tap on the
  // control is where the user asks why nothing happened.
  const [open, setOpen] = useState(false);
  if (!reason && !stable) return children;
  const describedBy = [children.props["aria-describedby"], reasonId ?? id]
    .filter(Boolean)
    .join(" ");
  // One tree with or without a reason, so a stable control is never
  // remounted (and never loses focus) when its reason comes or goes.
  const control = reason
    ? cloneElement(children, {
        "aria-disabled": true,
        "aria-describedby": describedBy,
        disabled: false,
        onClick: (event: MouseEvent<HTMLElement>) => {
          event.preventDefault();
          setOpen(true);
        },
      })
    : children;
  return (
    <>
      <Tooltip
        open={reason ? open : false}
        onOpenChange={(next) => setOpen(Boolean(reason) && next)}
      >
        <TooltipTrigger render={control} />
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      {!reasonId && reason ? (
        <span id={id} className="sr-only">
          {reason}
        </span>
      ) : null}
    </>
  );
}
