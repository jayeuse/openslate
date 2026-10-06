"use client";

import { useLayoutEffect, useState } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/** Presentation owns only the derived URL; the editor/query owns its Blob. */
export function WorkspaceLogo({
  blob,
  name,
  mark,
  hidden = false,
  className,
}: {
  blob?: Blob | null;
  name: string;
  mark: string;
  hidden?: boolean;
  className?: string;
}) {
  const [resource, setResource] = useState<{ blob: Blob; url: string } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!blob || hidden) return;
    const url = URL.createObjectURL(blob);
    setResource({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob, hidden]);
  const url =
    !hidden && resource !== null && resource.blob === blob
      ? resource.url
      : undefined;
  if (hidden)
    return (
      <span aria-hidden="true" className={cn("size-8 shrink-0", className)} />
    );
  return (
    <Avatar
      className={cn(
        "bg-foreground text-background size-8 overflow-hidden rounded-md text-xs font-bold after:rounded-[inherit]",
        className,
      )}
    >
      {url ? (
        <AvatarImage
          src={url}
          alt={`${name} logo`}
          className="rounded-[inherit] object-contain"
        />
      ) : null}
      <AvatarFallback
        role="img"
        aria-label={`${name} mark: ${mark}`}
        className="bg-foreground text-background rounded-[inherit]"
        style={{ fontSize: "inherit" }}
      >
        <span
          className="block w-full min-w-0 truncate px-1 text-center"
          title={mark}
        >
          {mark}
        </span>
      </AvatarFallback>
    </Avatar>
  );
}
