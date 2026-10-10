"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  type ProfileSelf,
} from "../adapters/profile-api";
import {
  profileSelfKey,
  profileSelfOptions,
} from "../adapters/profile-queries";

const labels = {
  display_name: "Display name",
  job_title: "Job title",
  phone: "Phone",
  bio: "Short bio",
} as const;
type Draft = Record<IdentityField, string>;
const emptyDraft: Draft = {
  display_name: "",
  job_title: "",
  phone: "",
  bio: "",
};
function selfDraft(self: ProfileSelf | undefined): Draft {
  return self
    ? {
        display_name: self.display_name ?? "",
        job_title: self.job_title ?? "",
        phone: self.phone ?? "",
        bio: self.bio ?? "",
      }
    : emptyDraft;
}

export default function Identity({
  onStateChange,
}: {
  onStateChange: (state: { dirty: boolean; pending: boolean }) => void;
}) {
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const client = useQueryClient();
  const query = useQuery({
    ...profileSelfOptions(userId),
    enabled: !suspended,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [invalid, setInvalid] = useState<IdentityField | null>(null);
  const [pending, setPending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [photo, setPhoto] = useState<{ id: string; url: string } | null>(null);
  const [photoError, setPhotoError] = useState("");
  const mounted = useRef(false);
  const epoch = useRef(0);
  const interaction = useRef(suspended);
  const operation = useRef<AbortController | null>(null);
  const needsRead = useRef(false);
  const rechecked = useRef(false);
  const refusedPhoto = useRef<string | null>(null);
  const self =
    !query.error && !suspended && !verifying ? query.data : undefined;
  const values = self ? (draft ?? selfDraft(self)) : emptyDraft;
  const dirty = Boolean(
    draft &&
    Object.keys(labels).some(
      (key) =>
        draft[key as IdentityField] !==
        selfDraft(query.data)[key as IdentityField],
    ),
  );
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
    setFeedback("");
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
      // refusal stays latched until a successful read or an explicit reload.
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
    setPhotoError("");
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
        setPhotoError(
          "Your photo could not be loaded. Reload profile to try again.",
        );
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

  useEffect(
    () => onStateChange({ dirty, pending }),
    [dirty, pending, onStateChange],
  );

  async function reload() {
    if (pending || interaction.current) return;
    rechecked.current = false;
    refusedPhoto.current = null;
    setVerifying(true);
    setFeedback("");
    const result = await query.refetch();
    if (!mounted.current || interaction.current) return;
    setVerifying(false);
    if (!result.error) {
      setError("");
      setPhotoError("");
    }
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
    setPending(true);
    setFeedback("");
    setError("");
    const submitted = draft;
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
        );
        if (!current()) return;
        patch = { avatar_file_id: uploaded.id };
      }
      if (!patch || !current()) return;
      let partial = false;
      try {
        await saveProfile(userId, patch, controller.signal);
      } catch (failure) {
        if (!profileCleanupPartial(failure)) throw failure;
        partial = true;
      }
      if (!current()) return;
      const result = await query.refetch({ throwOnError: true });
      if (!current() || !result.data) return;
      if (submitted && !file && !("avatar_file_id" in patch)) setDraft(null);
      if (partial)
        setError(
          "Profile saved; previous photo deletion is unfinished. Contact your administrator about cleanup.",
        );
      else setFeedback("Profile saved.");
      // Compact identity contains no private fields. Only existing directory
      // representations need invalidation after an accepted self edit.
      void client.invalidateQueries({
        queryKey: ["access", "directory"],
        refetchType: "none",
      });
    } catch (failure) {
      if (!current()) return;
      setError(
        file
          ? "Photo could not be saved. Its upload or binding outcome may be unavailable. Reload profile before trying again; no storage deletion is confirmed."
          : "Profile could not be saved. Reload profile to check your saved identity before trying again.",
      );
      if (profileNeedsSessionRecheck(failure)) requestSessionRecheck();
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setPending(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || !dirty || !self) return;
    const patch: ProfilePatch = {};
    for (const key of Object.keys(labels) as IdentityField[]) {
      if (Array.from(values[key]).length > identityLimits[key]) {
        setInvalid(key);
        setError(
          `${labels[key]} must use at most ${identityLimits[key]} characters.`,
        );
        return;
      }
      if (values[key] !== (self[key] ?? ""))
        patch[key] = values[key] === "" ? null : values[key];
    }
    setInvalid(null);
    void command(patch);
  }
  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <div className="flex flex-wrap items-center gap-4">
          {photo && self?.avatar_file_id === photo.id ? (
            <Image
              src={photo.url}
              alt="Your profile photo"
              width={80}
              height={80}
              unoptimized
              className="size-20 rounded-lg object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="bg-muted text-muted-foreground flex size-20 items-center justify-center rounded-lg text-xl font-semibold"
            >
              {self?.display_name?.slice(0, 1) ?? ""}
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <label
              htmlFor="profile-photo"
              className="block text-sm font-medium"
            >
              Upload photo
            </label>
            <Input
              id="profile-photo"
              type="file"
              accept="image/png,image/jpeg"
              className="min-h-11"
              disabled={blocked || Boolean(error)}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (!validAvatarSelection(file)) {
                  setError("Choose a PNG or JPEG photo up to 2 MiB.");
                  return;
                }
                void command(null, file);
              }}
            />
            <p className="text-muted-foreground text-sm">
              Private PNG or JPEG, up to 2 MiB.
            </p>
            {self?.avatar_file_id ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={blocked || Boolean(error)}
                onClick={() => void command({ avatar_file_id: null })}
              >
                Remove photo
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-muted-foreground text-sm">
          Email{" "}
          <span className="text-foreground break-all">
            {self?.email ?? "Unavailable"}
          </span>
        </p>
        <form
          noValidate
          onSubmit={submit}
          className="grid gap-4 sm:grid-cols-2"
        >
          {(Object.keys(labels) as IdentityField[]).map((key) => {
            const props = {
              id: `profile-${key}`,
              value: values[key],
              disabled: blocked,
              "aria-invalid": invalid === key,
              "aria-describedby": invalid === key ? "profile-error" : undefined,
              onChange: (event: { target: { value: string } }) => {
                setDraft({ ...values, [key]: event.target.value });
                setInvalid(null);
                setFeedback("");
              },
            };
            return (
              <Field
                key={key}
                className={key === "bio" ? "sm:col-span-2" : undefined}
              >
                <FieldLabel htmlFor={props.id}>{labels[key]}</FieldLabel>
                {key === "bio" ? (
                  <Textarea {...props} rows={3} />
                ) : (
                  <Input
                    {...props}
                    className="min-h-11"
                    type={key === "phone" ? "tel" : "text"}
                  />
                )}
              </Field>
            );
          })}
          <div className="space-y-3 sm:col-span-2">
            {query.isPending || verifying ? (
              <p role="status" className="text-muted-foreground text-sm">
                Loading profile…
              </p>
            ) : null}
            {pending ? (
              <p role="status" className="text-muted-foreground text-sm">
                Saving profile…
              </p>
            ) : null}
            {error || query.error || photoError ? (
              <p
                id="profile-error"
                role="alert"
                className="text-destructive text-sm"
              >
                {error ||
                  (query.error
                    ? "Profile could not be loaded. Reload profile to try again."
                    : photoError)}
              </p>
            ) : null}
            {feedback ? (
              <p role="status" className="text-sm">
                {feedback}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                className="min-h-11"
                disabled={blocked || !dirty || Boolean(error && !invalid)}
              >
                Save identity
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending || suspended || verifying}
                onClick={() => void reload()}
              >
                Reload profile
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
