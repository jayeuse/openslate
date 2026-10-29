"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { requestSessionRecheck } from "@/lib/auth-api";
import {
  identityLimits,
  profileCleanupPartial,
  profileNeedsSessionRecheck,
  readOwnAvatar,
  reserveAvatar,
  saveProfile,
  uploadAvatar,
  validAvatarSelection,
  type IdentityField,
  type ProfilePatch,
} from "@/components/profile/adapters/profile-api";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import {
  FILES_BUSY_MESSAGE,
  isFilesBusy,
} from "@/components/systems/shared/adapters/files-api";
import {
  profileSelfKey,
  profileSelfOptions,
} from "@/components/profile/adapters/profile-queries";
import { personProfilesKey } from "@/components/profile/adapters/profile-view-keys";
import {
  changedFields,
  IDENTITY_FIELDS,
  identityPatch,
  savedDraft,
  type IdentityDraft,
} from "../domain/identity-draft";

/** The visible row label of each Identity field; the control keeps its full name. */
export const identityLabels: Record<IdentityField, string> = {
  display_name: "Display name",
  job_title: "Job title",
  phone: "Phone",
  bio: "Bio",
};

const PHOTO_UNCERTAIN =
  "The photo may not have saved. Retry to check which photo is saved.";

/**
 * The Identity editor of Account settings (PD10): one owner for the draft,
 * its pending command, and the photo, shared by the Identity rows, the pinned
 * footer, and the Preview card. Text saves only through the footer; a photo
 * saves at once. A read failure or an uncertain photo outcome offers a read
 * Retry, which never repeats a write.
 */
export function useIdentityEditor() {
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const client = useQueryClient();
  const query = useQuery({
    ...profileSelfOptions(userId),
    enabled: !suspended,
  });
  const [draft, setDraft] = useState<IdentityDraft | null>(null);
  const [saveError, setSaveError] = useState("");
  const [photoError, setPhotoError] = useState("");
  // An uncertain photo outcome locks the photo controls until a read confirms.
  const [photoLocked, setPhotoLocked] = useState(false);
  const [photoReadError, setPhotoReadError] = useState("");
  const [saved, setSaved] = useState(false);
  // The Photo row's own words after a photo command (PD54): the photo saves
  // at once, so it never moves the Save profile chip.
  const [photoDone, setPhotoDone] = useState<"saved" | "removed" | null>(null);
  // The photo upload waits for file capacity on the server.
  const [photoWaiting, setPhotoWaiting] = useState(false);
  const [photoRunning, setPhotoRunning] = useState<"upload" | "remove" | null>(
    null,
  );
  const [invalid, setInvalid] = useState<IdentityField | null>(null);
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [photo, setPhoto] = useState<{ id: string; url: string } | null>(null);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const interaction = useRef(suspended);
  const operation = useRef<AbortController | null>(null);
  const needsRead = useRef(false);
  const rechecked = useRef(false);
  const refusedPhoto = useRef<string | null>(null);
  const self =
    !query.error && !suspended && !verifying ? query.data : undefined;
  const values = self ? (draft ?? savedDraft(self)) : savedDraft(undefined);
  const changed = changedFields(draft, query.data);
  const blocked = !self || pending || suspended || verifying;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      operation.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    interaction.current = suspended;
    if (suspended) {
      needsRead.current = true;
      epoch.current += 1;
      operation.current?.abort();
    }
  }, [suspended]);
  useEffect(() => {
    if (suspended || !needsRead.current) return;
    needsRead.current = false;
    setVerifying(true);
    setSaved(false);
    void query.refetch().finally(() => {
      if (mounted.current && !interaction.current) setVerifying(false);
    });
  }, [suspended, query.refetch]);
  useEffect(() => {
    if (!query.error && query.data) rechecked.current = false;
    if (
      !suspended &&
      query.error &&
      profileNeedsSessionRecheck(query.error) &&
      !rechecked.current
    ) {
      rechecked.current = true;
      // Reverification may refetch and create another error instance. One
      // refusal stays latched until a successful read or an explicit Retry.
      queueMicrotask(() => {
        if (mounted.current && !interaction.current) requestSessionRecheck();
      });
    }
  }, [query.error, query.data, suspended]);
  useEffect(() => {
    const id = self?.avatar_file_id;
    if (!id || refusedPhoto.current === id) return;
    const controller = new AbortController();
    let url: string | null = null;
    setPhotoReadError("");
    void readOwnAvatar(userId, id, controller.signal)
      .then((blob) => {
        if (
          controller.signal.aborted ||
          !mounted.current ||
          interaction.current
        )
          return;
        url = URL.createObjectURL(blob);
        refusedPhoto.current = null;
        setPhoto({ id, url });
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || !mounted.current) return;
        setPhotoReadError("Your photo could not be loaded.");
        if (profileNeedsSessionRecheck(failure)) {
          refusedPhoto.current = id;
          requestSessionRecheck();
        }
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
      setPhoto(null);
    };
  }, [userId, self?.avatar_file_id, query.dataUpdatedAt]);

  /** Read the saved profile again; it never repeats a write. */
  async function retry() {
    if (pending || interaction.current) return;
    rechecked.current = false;
    refusedPhoto.current = null;
    setVerifying(true);
    setSaved(false);
    const result = await query.refetch();
    if (!mounted.current || interaction.current) return;
    setVerifying(false);
    if (!result.error) {
      setPhotoError("");
      setPhotoLocked(false);
      setPhotoReadError("");
    }
  }
  function change(field: IdentityField, value: string) {
    setDraft({ ...values, [field]: value });
    setInvalid(null);
    setSaveError("");
    setSaved(false);
    setPhotoDone(null);
  }
  function discard() {
    setDraft(null);
    setInvalid(null);
    setSaveError("");
  }
  async function command(patch: ProfilePatch | null, file?: File) {
    if (blocked || operation.current || !self) return;
    const controller = new AbortController();
    operation.current = controller;
    const started = epoch.current;
    const current = () =>
      mounted.current &&
      epoch.current === started &&
      !interaction.current &&
      !controller.signal.aborted;
    const photoCommand = Boolean(file) || (patch && "avatar_file_id" in patch);
    setPending(true);
    setSaved(false);
    setSaveError("");
    setPhotoDone(null);
    if (photoCommand) {
      setPhotoError("");
      setPhotoRunning(file ? "upload" : "remove");
    }
    const submitted = draft;
    // The server refused the photo bytes before reading them; nothing changed.
    let uploadRefused = false;
    try {
      await client.cancelQueries({
        queryKey: profileSelfKey(userId),
        exact: true,
      });
      if (!current()) return;
      if (file) {
        const reserved = await reserveAvatar(userId, file, controller.signal);
        if (!current()) return;
        const uploaded = await uploadAvatar(
          userId,
          reserved.id,
          file,
          controller.signal,
          (waiting) => {
            if (current()) setPhotoWaiting(waiting);
          },
        ).catch((failure: unknown) => {
          uploadRefused = isFilesBusy(failure);
          throw failure;
        });
        if (!current()) return;
        patch = { avatar_file_id: uploaded.id };
      }
      if (!patch || !current()) return;
      let partial = false;
      try {
        await saveProfile(userId, patch, controller.signal, (waiting) => {
          if (current()) setPhotoWaiting(waiting);
        });
      } catch (failure) {
        if (!profileCleanupPartial(failure)) throw failure;
        partial = true;
      }
      if (!current()) return;
      const result = await query.refetch({ throwOnError: true });
      if (!current() || !result.data) return;
      if (submitted && !photoCommand) setDraft(null);
      if (partial) {
        setPhotoError(
          "Profile saved, but the old photo could not be deleted. Ask your administrator to delete it.",
        );
        setPhotoLocked(true);
      } else if (photoCommand) setPhotoDone(file ? "saved" : "removed");
      else setSaved(true);
      // An accepted self edit changes the directory rows and this account's
      // own Profile view, so both reads refetch on their next use. The shell's
      // identity read (account row, header avatar) refetches now.
      void client.invalidateQueries({
        queryKey: ["access", "directory"],
        refetchType: "none",
      });
      void client.invalidateQueries({
        queryKey: personProfilesKey(userId),
        refetchType: "none",
      });
      void client.invalidateQueries({ queryKey: authMeOptions().queryKey });
    } catch (failure) {
      if (!current()) return;
      if (uploadRefused || isFilesBusy(failure))
        setPhotoError(FILES_BUSY_MESSAGE);
      else if (photoCommand) {
        setPhotoError(PHOTO_UNCERTAIN);
        setPhotoLocked(true);
      } else setSaveError("Profile could not be saved. Try again.");
      if (profileNeedsSessionRecheck(failure)) requestSessionRecheck();
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) {
        setPending(false);
        setPhotoRunning(null);
        setPhotoWaiting(false);
      }
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || !changed.length || !self) return;
    for (const key of IDENTITY_FIELDS) {
      if (Array.from(values[key]).length > identityLimits[key]) {
        setInvalid(key);
        setSaveError("");
        return;
      }
    }
    setInvalid(null);
    void command(identityPatch(values, self));
  }
  function choosePhoto(file: File) {
    if (!validAvatarSelection(file)) {
      setPhotoDone(null);
      setPhotoError("Choose a PNG or JPEG photo up to 2 MB.");
      return;
    }
    void command(null, file);
  }

  const loadError = query.error
    ? "Profile could not be loaded."
    : photoReadError;
  return {
    self,
    values,
    changed,
    dirty: changed.length > 0,
    blocked,
    pending,
    loading: (query.isPending && !query.error) || verifying,
    saved,
    saveError,
    invalid,
    invalidMessage: invalid
      ? `${identityLabels[invalid]} must use at most ${identityLimits[invalid]} characters.`
      : "",
    loadError,
    photo: photo && self?.avatar_file_id === photo.id ? photo : null,
    photoError,
    /** The Photo row's status words: during, then after a photo command. */
    photoStatus:
      photoRunning === "upload"
        ? photoWaiting
          ? "Waiting for the server…"
          : "Uploading…"
        : photoRunning === "remove"
          ? "Removing…"
          : photoDone === "saved"
            ? "Photo saved"
            : photoDone === "removed"
              ? "Photo removed"
              : "",
    uploading: photoRunning === "upload",
    /** The upload waits for the server; its status words are shown, not only heard. */
    photoWaiting: photoRunning === "upload" && photoWaiting,
    photoDisabled: blocked || photoLocked,
    retryable: Boolean(loadError) || photoLocked,
    retrying: verifying,
    change,
    discard,
    retry: () => void retry(),
    submit,
    choosePhoto,
    removePhoto: () => void command({ avatar_file_id: null }),
  };
}

export type IdentityEditor = ReturnType<typeof useIdentityEditor>;
