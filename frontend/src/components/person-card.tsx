"use client";

import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import type { Route } from "next";
import { ArrowRight, X, UserRound } from "lucide-react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
} from "@/components/ui/popover";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { PersonAvatar } from "@/components/person-avatar";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { AvatarBadge } from "@/components/ui/avatar";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import {
  readPersonAvatar,
  type PersonCard,
} from "@/components/profile/adapters/profile-api";
import {
  personCardKey,
  personCardOptions,
} from "@/components/profile/adapters/profile-queries";

type PersonCardPopoverProps = {
  personId: string;
  /** A current authorized source label. Omit only when the source provides an id without a name. */
  label?: string;
  unavailableLabel?: string;
  className?: string;
  /** "none" when the name sits in a row that has its own link action. */
  decoration?: "underline" | "none";
  /** Optional current, source-authorized presence; never an identity grant. */
  presence?: string;
  /** Keep an open card attached to its actor when a live list regroups them. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** One read-only identity disclosure. The account QueryClient deduplicates known visible targets. */
export function PersonCardPopover(props: PersonCardPopoverProps) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? (
    <VerifiedPersonCard {...props} />
  ) : (
    createElement("span", null, props.label ?? "Loading person…")
  );
}

function VerifiedPersonCard(props: PersonCardPopoverProps) {
  const viewerId = useVerifiedWorkspaceUserId();
  return (
    <BoundPersonCard
      key={`${viewerId}:${props.personId}`}
      {...props}
      viewerId={viewerId}
    />
  );
}

function BoundPersonCard({
  personId,
  label,
  unavailableLabel = "Person unavailable",
  className,
  decoration = "underline",
  presence,
  open: controlledOpen,
  onOpenChange,
  viewerId,
}: PersonCardPopoverProps & { viewerId: string }) {
  const suspended = useWorkspaceInteractionSuspended();
  const client = useQueryClient();
  const identity = useQuery({ ...authMeOptions(), enabled: !suspended });
  const viewer = { id: viewerId, role: identity.data?.role ?? "guest" };
  const admitted =
    !suspended && !identity.error && identity.data?.id === viewerId;
  const [intent, setIntent] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = useCallback(
    (value: boolean) => {
      setLocalOpen(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );
  const options = personCardOptions(viewer, personId);
  const read = useQuery({
    ...options,
    enabled: (query) =>
      admitted && (open || intent || !label) && !query.state.error,
  });
  const current =
    admitted &&
    !read.error &&
    read.data?.viewer.id === viewerId &&
    read.data.viewer.role === viewer.role &&
    read.data.targetId === personId
      ? read.data
      : undefined;
  // Source labels remain source-owned. An id-only event gets no guessed name or raw UUID.
  const name = label ?? current?.data.display_name;
  const viewerRole = viewer.role;
  const refuse = useCallback(
    (source: PersonCard, error: Error) => {
      const key = personCardKey({ id: viewerId, role: viewerRole }, personId);
      if (
        client.getQueryData(key) !== source ||
        client.getQueryState(key)?.fetchStatus === "fetching"
      )
        return;
      client
        .getQueryCache()
        .find({
          queryKey: personCardKey({ id: viewerId, role: viewerRole }, personId),
          exact: true,
        })
        ?.setState({ data: undefined, error, status: "error" });
    },
    [client, viewerId, viewerRole, personId],
  );
  const accept = useCallback(
    (source: PersonCard, card: PersonCard) => {
      const key = personCardKey({ id: viewerId, role: viewerRole }, personId);
      if (
        client.getQueryData(key) !== source ||
        client.getQueryState(key)?.error ||
        client.getQueryState(key)?.fetchStatus === "fetching"
      )
        return false;
      client.setQueryData(key, card);
      return true;
    },
    [client, viewerId, viewerRole, personId],
  );

  useLayoutEffect(() => {
    if (!suspended) return;
    setOpen(false);
    setIntent(false);
    const queryKey = personCardKey(
      { id: viewerId, role: viewerRole },
      personId,
    );
    void client.cancelQueries({ queryKey, exact: true });
    void client.invalidateQueries({
      queryKey,
      exact: true,
      refetchType: "none",
    });
  }, [suspended, client, viewerId, personId, viewerRole, setOpen]);

  function prepare() {
    if (!admitted) return;
    setIntent(true);
    if (!client.getQueryState(options.queryKey)?.error)
      void client.prefetchQuery(options);
  }

  if (!name)
    return (
      <span
        role={read.isPending ? "status" : undefined}
        className="text-muted-foreground"
      >
        {read.error ? unavailableLabel : "Loading person…"}
        {read.error ? (
          <Button
            type="button"
            variant="ghost"
            className="ml-1 min-h-11"
            onClick={() => void read.refetch()}
          >
            Retry person card
          </Button>
        ) : null}
      </span>
    );

  return (
    <Popover
      open={open && admitted}
      onOpenChange={(next) => {
        if (next) prepare();
        setOpen(next);
      }}
    >
      <PopoverTrigger
        type="button"
        aria-label={`Person card: ${name}`}
        disabled={!admitted}
        onPointerEnter={prepare}
        onFocus={prepare}
        className={cn(
          "text-primary focus-visible:outline-ring relative z-10 inline-flex min-h-11 max-w-full min-w-11 items-center gap-2 rounded-sm text-left break-words focus-visible:outline-2 focus-visible:outline-offset-2",
          className,
        )}
      >
        <span className="relative shrink-0">
          <PersonAvatar name={name} avatarUrl={current?.data.avatar_url} />
          {presence && admitted && !read.error && (
            <AvatarBadge
              role="img"
              aria-label={presence}
              title={presence}
              className={cn(
                "size-2",
                presence === "Offline"
                  ? "bg-muted-foreground"
                  : presence === "Away"
                    ? "bg-warn"
                    : "bg-flow",
              )}
            />
          )}
        </span>
        <span
          className={cn(
            "min-w-0",
            decoration === "underline" && "underline underline-offset-4",
          )}
        >
          {name}
        </span>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Person card"
        align="start"
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-1.5rem)] gap-4 p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle>Person card</PopoverTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Close person card"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        {read.error || !admitted ? (
          <div className="space-y-3">
            <p role="alert" className="text-destructive">
              Person unavailable. Check your access or retry.
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={read.isFetching}
              onClick={() => void read.refetch()}
            >
              Retry person card
            </Button>
          </div>
        ) : (
          <LoadingRegion
            loading={!current}
            label="Loading person card…"
            skeleton={
              <div className="space-y-3">
                <Skeleton className="size-14 rounded-full" />
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-48" />
              </div>
            }
          >
            {current ? (
              <>
                <PersonCardDetails
                  key={`${viewerId}:${viewer.role}:${personId}`}
                  card={current}
                  active={open && admitted}
                  onRefused={refuse}
                  onAccepted={accept}
                />
                {presence && (
                  <p className="text-muted-foreground text-sm">{presence}</p>
                )}
              </>
            ) : null}
          </LoadingRegion>
        )}
        {current ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={read.isFetching}
              onClick={() => void read.refetch()}
            >
              Reload person card
            </Button>
            <GuardedWorkspaceLink
              href={`/profile?person=${encodeURIComponent(personId)}` as Route}
              onAcceptedNavigate={() => setOpen(false)}
              className="text-action-text focus-visible:outline-ring inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              View profile
              <ArrowRight aria-hidden="true" className="size-4" />
            </GuardedWorkspaceLink>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PersonCardDetails({
  card,
  active,
  onRefused,
  onAccepted,
}: {
  card: PersonCard;
  active: boolean;
  onRefused: (source: PersonCard, error: Error) => void;
  onAccepted: (source: PersonCard, card: PersonCard) => boolean;
}) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const [retry, setRetry] = useState(0);
  const avatar = card.data.avatar_url;
  const targetId = card.targetId;
  const viewerId = card.viewer.id;
  const viewerRole = card.viewer.role;
  const source = useRef(card);
  useLayoutEffect(() => {
    source.current = card;
  }, [card]);
  useEffect(() => {
    if (!active || !avatar) return;
    const controller = new AbortController();
    const startedWith = source.current;
    let url: string | null = null;
    setPhotoError(false);
    void readPersonAvatar(
      {
        targetId,
        viewer: { id: viewerId, role: viewerRole },
        avatarUrl: avatar,
      },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.status === "card-unavailable") {
          onRefused(startedWith, result.error);
          return;
        }
        if (!onAccepted(startedWith, result.card)) return;
        if (!result.blob || source.current !== startedWith) return;
        url = URL.createObjectURL(result.blob);
        setPhoto(url);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPhotoError(true);
        if (error instanceof ApiError && [401, 403, 404].includes(error.status))
          onRefused(startedWith, error);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      setPhoto(null);
    };
    // Text refetches do not replay a failed photo read. Retry is explicit.
  }, [
    active,
    avatar,
    targetId,
    viewerId,
    viewerRole,
    retry,
    onRefused,
    onAccepted,
  ]);

  const privateData = "email" in card.data ? card.data : null;
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 items-start gap-3">
        {photo && active ? (
          <Image
            unoptimized
            src={photo}
            alt={`${card.data.display_name} photo`}
            width={56}
            height={56}
            className="size-14 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="bg-muted text-muted-foreground flex size-14 shrink-0 items-center justify-center rounded-full"
          >
            <UserRound className="size-7" />
          </span>
        )}
        <div className="min-w-0">
          <p className="font-semibold wrap-anywhere">
            {card.data.display_name}
          </p>
          <p className="text-muted-foreground mt-1 wrap-anywhere">
            {card.data.job_title?.trim() ? card.data.job_title : "Not provided"}
          </p>
        </div>
      </div>
      {photoError ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">
            Photo unavailable.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry photo
          </Button>
        </div>
      ) : null}
      {privateData ? (
        <dl className="space-y-3">
          {(
            [
              ["Email", privateData.email],
              ["Phone", privateData.phone],
              ["Bio", privateData.bio],
            ] as const
          ).map(([name, value]) => (
            <div key={name}>
              <dt className="text-muted-foreground text-xs">{name}</dt>
              <dd className="mt-1 wrap-anywhere whitespace-pre-wrap">
                {value?.trim() ? value : "Not provided"}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
