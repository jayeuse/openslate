"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Waits this long before a skeleton shows, so fast loads never flash one. */
export const SKELETON_DELAY_MS = 300;
/** Once shown, a skeleton stays at least this long, so it never blinks. */
export const SKELETON_MIN_MS = 300;

/**
 * Whether a skeleton is visible for a load: not before `delay`, and, once
 * visible, for at least `minimum` even if the load ends sooner.
 */
export function useSkeletonVisible(
  loading: boolean,
  delay = SKELETON_DELAY_MS,
  minimum = SKELETON_MIN_MS,
): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading && !visible) {
      const timer = setTimeout(() => {
        shownAt.current = performance.now();
        setVisible(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!loading && visible) {
      const shown = performance.now() - (shownAt.current ?? 0);
      const timer = setTimeout(
        () => {
          shownAt.current = null;
          setVisible(false);
        },
        Math.max(0, minimum - shown),
      );
      return () => clearTimeout(timer);
    }
  }, [loading, visible, delay, minimum]);

  return visible;
}

type LoadingRegionProps = {
  /** True while the region's data is on its way. */
  loading: boolean;
  /** A layout-matched placeholder, built from `Skeleton`. */
  skeleton: ReactNode;
  /** Announced to screen readers once the skeleton shows. */
  label: string;
  className?: string;
  children?: ReactNode;
};

/**
 * One loading pattern for data regions. The page frame renders at once and
 * this region holds its space: for the first 300ms the skeleton is laid out
 * but invisible, so a fast load shows no placeholder and no layout jump.
 * After that the skeleton shows for at least 300ms. Data that replaces a
 * loading state fades in over `--motion-fast`; cached data appears at once.
 */
export function LoadingRegion({
  loading,
  skeleton,
  label,
  className,
  children,
}: LoadingRegionProps) {
  const skeletonVisible = useSkeletonVisible(loading);
  const showSkeleton = loading || skeletonVisible;
  // Content fades in only when it replaces a loading state in this region.
  // Set during render (not in an effect), so the first content frame
  // already carries the fade.
  const [replacesLoading, setReplacesLoading] = useState(loading);
  if (loading && !replacesLoading) setReplacesLoading(true);

  return (
    <div
      data-slot="loading-region"
      aria-busy={showSkeleton}
      className={className}
    >
      {showSkeleton ? (
        <div className={cn(!skeletonVisible && "invisible")}>
          {skeletonVisible ? (
            <span role="status" className="sr-only">
              {label}
            </span>
          ) : null}
          {skeleton}
        </div>
      ) : (
        <div
          className={cn(
            replacesLoading && "animate-content-in motion-reduce:animate-none",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
