"use client";

import { useCallback, useState } from "react";

export interface UseDiscardGuardOptions {
  dirty: boolean;
  pending?: boolean;
  onClose: () => void;
}

export interface UseDiscardGuardResult {
  discardOpen: boolean;
  requestClose: () => void;
  cancelDiscard: () => void;
  confirmDiscard: () => void;
}

/**
 * Coordinates unsaved-close confirmation without owning a dialog's markup or
 * its focus/navigation behavior.
 */
export function useDiscardGuard({
  dirty,
  pending = false,
  onClose,
}: UseDiscardGuardOptions): UseDiscardGuardResult {
  const [discardOpen, setDiscardOpen] = useState(false);

  const requestClose = useCallback(() => {
    if (pending) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose, pending]);

  const cancelDiscard = useCallback(() => {
    setDiscardOpen(false);
  }, []);

  const confirmDiscard = useCallback(() => {
    if (pending) return;
    setDiscardOpen(false);
    onClose();
  }, [onClose, pending]);

  return { discardOpen, requestClose, cancelDiscard, confirmDiscard };
}
