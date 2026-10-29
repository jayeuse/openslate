"use client";

import { useRef, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { personInitials } from "@/components/person-avatar";
import type { IdentityField } from "@/components/profile/adapters/profile-api";
import {
  identityLabels,
  type IdentityEditor,
} from "../hooks/use-identity-editor";
import { RowError, RowNote, SettingsRow, SettingsSection } from "./rows";

/**
 * Identity (PD10): the photo, which saves at once with its own status words
 * (PD54), then Display name, Job title, Phone and Bio, which save through the
 * pinned footer (the form is `identity-form`), and the sign-in email with its
 * quiet Change. Each row label is the field's full name (PD58).
 */
export function IdentitySection({
  editor,
  email,
}: {
  editor: IdentityEditor;
  /** The Email row: the address and its Change action. */
  email: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { self, values, invalid } = editor;
  return (
    <SettingsSection id="identity" title="Identity">
      {editor.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading profile…
        </p>
      ) : null}
      {editor.loadError || (editor.retryable && editor.photoError) ? (
        <Alert
          role="alert"
          variant="destructive"
          className="flex flex-wrap items-center gap-3"
        >
          <p className="mr-auto min-w-0">
            {editor.loadError || editor.photoError}
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            disabled={editor.pending || editor.retrying}
            onClick={editor.retry}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
      <SettingsRow label="Photo" htmlFor="profile-photo">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Avatar className="mr-1 size-10">
            {editor.photo ? (
              <AvatarImage src={editor.photo.url} alt="Your profile photo" />
            ) : null}
            <AvatarFallback
              aria-hidden="true"
              className="text-muted-foreground text-sm font-semibold"
            >
              {self ? personInitials(self.display_name ?? "") : ""}
            </AvatarFallback>
          </Avatar>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            disabled={editor.photoDisabled}
            onClick={() => input.current?.click()}
          >
            {editor.uploading ? "Uploading…" : "Choose photo"}
          </Button>
          {/* The native input stays in the DOM, unseen, so its label and
              the browser's file chooser still work. */}
          <input
            ref={input}
            id="profile-photo"
            type="file"
            accept="image/png,image/jpeg"
            aria-label="Upload photo"
            aria-describedby="profile-photo-note"
            className="sr-only"
            tabIndex={-1}
            disabled={editor.photoDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) editor.choosePhoto(file);
            }}
          />
          {self?.avatar_file_id ? (
            <Button
              type="button"
              variant="outline"
              aria-label="Remove photo"
              className="min-h-11 xl:min-h-8"
              disabled={editor.photoDisabled}
              onClick={editor.removePhoto}
            >
              Remove
            </Button>
          ) : null}
          {/* The button already shows "Uploading…", so that word is heard,
              not shown twice; a wait for the server and the result are
              shown. */}
          <span
            role="status"
            className="text-muted-foreground text-[0.8125rem]"
          >
            {editor.uploading && !editor.photoWaiting ? (
              <span className="sr-only">{editor.photoStatus}</span>
            ) : (
              editor.photoStatus
            )}
          </span>
        </div>
        <RowNote id="profile-photo-note">PNG or JPEG, up to 2 MB.</RowNote>
        {editor.retryable ? null : (
          <RowError id="profile-photo-error">{editor.photoError}</RowError>
        )}
      </SettingsRow>
      <form
        id="identity-form"
        noValidate
        onSubmit={editor.submit}
        className="contents"
      >
        {(Object.keys(identityLabels) as IdentityField[]).map((key) => {
          const id = `profile-${key}`;
          const errorId = `${id}-error`;
          const props = {
            id,
            value: values[key],
            disabled: editor.blocked,
            "aria-label": identityLabels[key],
            "aria-invalid": invalid === key,
            "aria-describedby": invalid === key ? errorId : undefined,
            onChange: (event: { target: { value: string } }) =>
              editor.change(key, event.target.value),
          };
          return (
            <SettingsRow key={key} label={identityLabels[key]} htmlFor={id}>
              {key === "bio" ? (
                <Textarea
                  {...props}
                  rows={2}
                  placeholder="A line about your work"
                />
              ) : (
                <Input
                  {...props}
                  className={
                    key === "phone"
                      ? "min-h-11 md:max-w-70"
                      : "min-h-11 md:max-w-[35rem]"
                  }
                  type={key === "phone" ? "tel" : "text"}
                />
              )}
              <RowError id={errorId}>
                {invalid === key ? editor.invalidMessage : undefined}
              </RowError>
            </SettingsRow>
          );
        })}
      </form>
      <SettingsRow label="Email">{email}</SettingsRow>
    </SettingsSection>
  );
}
