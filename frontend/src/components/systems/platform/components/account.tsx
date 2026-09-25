"use client";
import { useEffect, useState } from "react";
import { sampleOperationMessage } from "../../shared/runtime/sample-async";
import { Action, Choice, Panel } from "../../shared/components/ui";
import type { PlatformCommandResult } from "../adapters/runtime";
import type { PlatformAccount, PlatformSession } from "../domain/model";

type AccountProps = {
  preferences: PlatformAccount;
  sessions: PlatformSession[];
  onAccountChange: (
    patch: Partial<PlatformAccount>,
  ) => Promise<PlatformCommandResult<PlatformAccount>>;
  onEndSession: (sessionId: string) => Promise<PlatformCommandResult<string>>;
  pending: (key?: string) => boolean;
};

type PreferenceKey = "language" | "theme" | "presence";
const PREFERENCE_KEYS: PreferenceKey[] = ["language", "theme", "presence"];
const PREFERENCE_COPY: Record<
  PreferenceKey,
  { label: string; success: string; fallback: string }
> = {
  language: {
    label: "Display language",
    success: "Language preference saved.",
    fallback: "The language preference could not be saved. Try again.",
  },
  theme: {
    label: "Theme",
    success: "Theme preference saved.",
    fallback: "The theme preference could not be saved. Try again.",
  },
  presence: {
    label: "My presence",
    success: "Presence updated.",
    fallback: "Presence could not be saved. Try again.",
  },
};

export default function Account({
  preferences,
  sessions,
  onAccountChange,
  onEndSession,
  pending,
}: AccountProps) {
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState("");
  const [preferenceDrafts, setPreferenceDrafts] = useState<
    Partial<Record<PreferenceKey, string>>
  >({});
  const [preferenceErrors, setPreferenceErrors] = useState<
    Partial<Record<PreferenceKey, string>>
  >({});
  const language = preferenceDrafts.language ?? preferences.language;
  const theme = preferenceDrafts.theme ?? preferences.theme;
  const presence = preferenceDrafts.presence ?? preferences.presence;
  useEffect(() => {
    setPreferenceDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of PREFERENCE_KEYS) {
        if (next[key] !== undefined && next[key] === preferences[key]) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [preferences.language, preferences.theme, preferences.presence]);
  function setPreferenceError(key: PreferenceKey, message: string) {
    setPreferenceErrors((current) => ({ ...current, [key]: message }));
  }
  function clearPreferenceError(key: PreferenceKey) {
    setPreferenceErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  async function update(
    patch: Partial<PlatformAccount>,
    success: string,
    preference?: {
      key: PreferenceKey;
      value: string;
      fallback: string;
    },
  ) {
    if (preference) {
      setPreferenceDrafts((current) => ({
        ...current,
        [preference.key]: preference.value,
      }));
      clearPreferenceError(preference.key);
    }
    try {
      const result = await onAccountChange(patch);
      if (result.ok) {
        setNotice(success);
        if (preference) clearPreferenceError(preference.key);
        return true;
      }
      setNotice(result.error);
      if (preference) setPreferenceError(preference.key, result.error);
    } catch (error) {
      const message = sampleOperationMessage(
        error,
        preference?.fallback ??
          "The account change could not be saved. Try again.",
      );
      setNotice(message);
      if (preference) setPreferenceError(preference.key, message);
    }
    return false;
  }
  function updatePreference(key: PreferenceKey, value: string) {
    void update(
      { [key]: value } as Partial<PlatformAccount>,
      PREFERENCE_COPY[key].success,
      { key, value, fallback: PREFERENCE_COPY[key].fallback },
    );
  }
  function retryPreference(key: PreferenceKey) {
    const value = preferenceDrafts[key];
    if (value === undefined) return;
    updatePreference(key, value);
  }
  return (
    <div
      className={`${theme === "Dark" ? "dark" : ""} bg-background text-foreground grid items-start gap-5 rounded-xl xl:grid-cols-2`}
    >
      <Panel title="Personal preferences">
        <p className="text-muted-foreground text-sm">
          These settings change the displayed account. Your sign-in account and
          session are unchanged.
        </p>
        <Choice
          label="Display language"
          value={language}
          disabled={pending("platform:account:update")}
          onChange={(event) => updatePreference("language", event.target.value)}
        >
          <option>English</option>
          <option>Filipino</option>
        </Choice>
        <p className="bg-muted rounded-lg p-3 text-sm">
          {language === "Filipino"
            ? "Maligayang pagdating. Handa na ang iyong workspace."
            : "Welcome back. Your workspace is ready."}
        </p>
        <Choice
          label="Theme"
          value={theme}
          disabled={pending("platform:account:update")}
          onChange={(event) => updatePreference("theme", event.target.value)}
        >
          <option>Light</option>
          <option>Dark</option>
        </Choice>
        <p className="text-muted-foreground text-xs">
          The account preview adopts your selected theme.
        </p>
        <Choice
          label="My presence"
          value={presence}
          disabled={pending("platform:account:update")}
          onChange={(event) => updatePreference("presence", event.target.value)}
        >
          {["Available", "Busy", "Away", "Offline"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </Choice>
        <p className="text-sm">
          Your status: <strong>{presence}</strong>
        </p>
        {PREFERENCE_KEYS.map((key) =>
          preferenceErrors[key] ? (
            <div
              key={key}
              role="alert"
              className="border-destructive/50 bg-destructive/10 space-y-2 rounded-lg border p-3 text-sm"
            >
              <p>
                {PREFERENCE_COPY[key].label}: {preferenceErrors[key]}
              </p>
              <Action
                size="sm"
                variant="outline"
                disabled={pending("platform:account:update")}
                onClick={() => retryPreference(key)}
              >
                Retry {PREFERENCE_COPY[key].label.toLowerCase()}
              </Action>
            </div>
          ) : null,
        )}
        <div className="space-y-3 border-t pt-4">
          <h3 className="font-medium">Team presence</h3>
          {[
            ["Morgan Kim", "Available"],
            ["Alex Lee", "Busy"],
            ["Pat Riley", "Away"],
            ["Jamie Torres", "Offline"],
          ].map(([name, status]) => (
            <p key={name} className="flex justify-between gap-3 text-sm">
              <span>{name}</span>
              <span className="text-muted-foreground">{status}</span>
            </p>
          ))}
        </div>
      </Panel>
      <Panel title="Account security">
        <div className="space-y-3">
          <h3 className="font-medium">Password change</h3>
          <p className="text-muted-foreground text-sm">
            Use the provided credential to review this action. Your sign-in
            password will not change; never enter it here.
          </p>
          <div className="rounded-lg border p-3 text-sm">
            New password: •••••••••••• · Strength: strong
          </div>
          <Action
            onClick={() => setConfirm("password")}
            disabled={pending("platform:account:update")}
          >
            Review password change
          </Action>
          {preferences.passwordChanged && (
            <p role="status" className="text-sm">
              Password change reviewed. Your sign-in password is unchanged.
            </p>
          )}
        </div>
        <div className="space-y-3 border-t pt-4">
          <h3 className="font-medium">Device sessions</h3>
          <p className="text-muted-foreground text-sm">
            Ending a listed session will not sign out that device.
          </p>
          {sessions.map((session) => (
            <div
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
            >
              <span>
                {session.device}
                {session.current ? " · Current session" : ""}
              </span>
              {!session.current && (
                <Action
                  onClick={() => setConfirm(session.id)}
                  disabled={pending(`platform:session:end:${session.id}`)}
                >
                  End session
                </Action>
              )}
            </div>
          ))}
        </div>
        <Action
          onClick={() => setConfirm("logout")}
          disabled={pending("platform:account:update")}
        >
          Review sign-out
        </Action>
        {notice && (
          <p role="status" className="bg-muted rounded-lg p-3 text-sm">
            {notice}
          </p>
        )}
        {preferences.signedOut && (
          <div
            role="status"
            className="bg-muted space-y-3 rounded-lg p-3 text-sm"
          >
            <p>Sign-out flow completed. Your sign-in session remains active.</p>
            <Action
              disabled={pending("platform:account:update")}
              onClick={() =>
                void update(
                  { signedOut: false },
                  "Returned to the account view.",
                )
              }
            >
              Return to account view
            </Action>
          </div>
        )}
        {confirm && (
          <section
            role="region"
            aria-label="Confirm account action"
            className="space-y-3 rounded-lg border p-4"
          >
            <p className="text-sm">
              {confirm === "password"
                ? "Review the provided password change? Your sign-in password will stay the same."
                : confirm === "logout"
                  ? "Review sign-out? Your sign-in session will remain active."
                  : "End the displayed tablet session? No device will be signed out."}
            </p>
            <div className="flex gap-2">
              <Action onClick={() => setConfirm("")} disabled={pending()}>
                Cancel
              </Action>
              <Action
                variant="default"
                disabled={pending()}
                onClick={() => {
                  void (async () => {
                    if (confirm === "password") {
                      if (
                        await update(
                          { passwordChanged: true },
                          "Password change reviewed. Your sign-in password is unchanged.",
                        )
                      )
                        setConfirm("");
                    } else if (confirm === "logout") {
                      if (
                        await update(
                          { signedOut: true },
                          "Sign-out flow completed. Your sign-in session remains active.",
                        )
                      )
                        setConfirm("");
                    } else {
                      try {
                        const result = await onEndSession(confirm);
                        if (result.ok) {
                          setNotice(
                            "Displayed session ended. No device was signed out.",
                          );
                          setConfirm("");
                        } else setNotice(result.error);
                      } catch (error) {
                        setNotice(
                          sampleOperationMessage(
                            error,
                            "The displayed session could not be ended. Try again.",
                          ),
                        );
                      }
                    }
                  })();
                }}
              >
                Confirm
              </Action>
            </div>
          </section>
        )}
      </Panel>
    </div>
  );
}
