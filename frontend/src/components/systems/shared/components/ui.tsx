"use client";

import { useId, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Shared sample-screen action button with the project's minimum touch target. */
export function Action(props: ComponentProps<typeof Button>) {
  const button = (
    <Button
      variant="outline"
      {...props}
      className={`min-h-11 ${props.className ?? ""}`}
    />
  );
  return props["aria-label"] ? (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{props["aria-label"]}</TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}

/** Shared labeled select used by sample feature configuration screens. */
export function Choice({
  label,
  children,
  id,
  className,
  ...props
}: ComponentProps<typeof NativeSelect> & { label: string }) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <Field>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <NativeSelect
        {...props}
        id={controlId}
        className={cn("w-full [&_select]:min-h-11", className)}
      >
        {children}
      </NativeSelect>
    </Field>
  );
}

/** Shared labeled checkbox or switch used by sample feature settings. */
export function Toggle({
  label,
  id,
  className,
  control = "checkbox",
  ...props
}: {
  label: string;
  id?: string;
  className?: string;
  control?: "checkbox" | "switch";
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const Control = control === "switch" ? Switch : Checkbox;
  return (
    <Field className="min-h-11 flex-row items-center gap-3">
      <Control {...props} id={controlId} className={className} />
      <FieldLabel
        htmlFor={controlId}
        className="flex-1 cursor-pointer font-normal"
      >
        {label}
      </FieldLabel>
    </Field>
  );
}

/** Shared titled surface for sample feature sections. */
export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}
