"use client";
import { useState } from "react";
import { useSampleState } from "@/components/sample/sample-state";
import { Action, Choice, Panel } from "../comms/ui";
export default function Account() {
  const [preferences, setPreferences] = useSampleState("platformAccount", {
    language: "English",
    theme: "Light",
    presence: "Available",
    passwordChanged: false,
    signedOut: false,
  });
  const [sessions, setSessions] = useSampleState("platformSessions", [
    { id: "sample-current", device: "This browser", current: true },
    { id: "sample-tablet", device: "Workshop tablet", current: false },
  ]);
  const [confirm, setConfirm] = useState("");
  return (
    <div
      className={`${preferences.theme === "Dark" ? "dark" : ""} bg-background text-foreground grid items-start gap-5 rounded-xl xl:grid-cols-2`}
    >
      <Panel title="Personal preferences">
        <p className="text-muted-foreground text-sm">
          These settings belong to the sample account. Your live account and
          session are unchanged.
        </p>
        <Choice
          label="Display language"
          value={preferences.language}
          onChange={(event) =>
            setPreferences((value) => ({
              ...value,
              language: event.target.value,
            }))
          }
        >
          <option>English</option>
          <option>Filipino</option>
        </Choice>
        <p className="bg-muted rounded-lg p-3 text-sm">
          {preferences.language === "Filipino"
            ? "Maligayang pagdating. Handa na ang iyong workspace."
            : "Welcome back. Your workspace is ready."}
        </p>
        <Choice
          label="Sample theme"
          value={preferences.theme}
          onChange={(event) =>
            setPreferences((value) => ({ ...value, theme: event.target.value }))
          }
        >
          <option>Light</option>
          <option>Dark</option>
        </Choice>
        <p className="text-muted-foreground text-xs">
          The account preview adopts your selected theme.
        </p>
        <Choice
          label="My presence"
          value={preferences.presence}
          onChange={(event) =>
            setPreferences((value) => ({
              ...value,
              presence: event.target.value,
            }))
          }
        >
          {["Available", "Busy", "Away", "Offline"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </Choice>
        <p className="text-sm">
          Your sample status: <strong>{preferences.presence}</strong>
        </p>
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
          <h3 className="font-medium">Password demonstration</h3>
          <p className="text-muted-foreground text-sm">
            A sample credential is supplied automatically. Never enter your real
            password here.
          </p>
          <div className="rounded-lg border p-3 text-sm">
            New password: •••••••••••• · Sample strength: strong
          </div>
          <Action onClick={() => setConfirm("password")}>
            Change sample password
          </Action>
          {preferences.passwordChanged && (
            <p role="status" className="text-sm">
              Sample password changed. Your real credentials are unchanged.
            </p>
          )}
        </div>
        <div className="space-y-3 border-t pt-4">
          <h3 className="font-medium">My sample sessions</h3>
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
                <Action onClick={() => setConfirm(session.id)}>
                  End session
                </Action>
              )}
            </div>
          ))}
        </div>
        <Action onClick={() => setConfirm("logout")}>
          Log out of sample account
        </Action>
        {preferences.signedOut && (
          <div
            role="status"
            className="bg-muted space-y-3 rounded-lg p-3 text-sm"
          >
            <p>
              Sample account is signed out. Your live session remains active.
            </p>
            <Action
              onClick={() =>
                setPreferences((value) => ({ ...value, signedOut: false }))
              }
            >
              Return to sample account
            </Action>
          </div>
        )}
        {confirm && (
          <section
            role="region"
            aria-label="Confirm sample account action"
            className="space-y-3 rounded-lg border p-4"
          >
            <p className="text-sm">
              {confirm === "password"
                ? "Apply the bundled sample password?"
                : confirm === "logout"
                  ? "Sign out the sample account?"
                  : "End the workshop tablet’s sample session?"}
            </p>
            <div className="flex gap-2">
              <Action onClick={() => setConfirm("")}>Cancel</Action>
              <Action
                variant="default"
                onClick={() => {
                  if (confirm === "password")
                    setPreferences((value) => ({
                      ...value,
                      passwordChanged: true,
                    }));
                  else if (confirm === "logout")
                    setPreferences((value) => ({ ...value, signedOut: true }));
                  else
                    setSessions((items) =>
                      items.filter((item) => item.id !== confirm),
                    );
                  setConfirm("");
                }}
              >
                Confirm sample action
              </Action>
            </div>
          </section>
        )}
      </Panel>
    </div>
  );
}
