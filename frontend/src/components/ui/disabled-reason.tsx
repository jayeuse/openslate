"use client";

import { cloneElement, useId, type MouseEvent, type ReactElement } from "react";

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
 * reason, the control renders unchanged.
 */
export function DisabledReason({
  reason,
  children,
}: {
  reason: string | null | undefined;
  children: ReactElement<ControlProps>;
}) {
  const id = useId();
  if (!reason) return children;
  const describedBy = [children.props["aria-describedby"], id]
    .filter(Boolean)
    .join(" ");
  const control = cloneElement(children, {
    "aria-disabled": true,
    "aria-describedby": describedBy,
    disabled: false,
    onClick: (event: MouseEvent<HTMLElement>) => event.preventDefault(),
  });
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={control} />
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}
