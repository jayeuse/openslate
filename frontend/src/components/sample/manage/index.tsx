"use client";
import { useState } from "react";
import { ShieldCheck, Building2, HardDrive, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSampleState } from "@/components/sample/sample-state";
import {
  Actions,
  Check,
  Choice,
  Editor,
  Field,
  Section,
  Tabs,
} from "../access/primitives";
import SampleAudit from "./audit";
import { initialPeople, type Person } from "../access/model";

type Settings = {
  name: string;
  logo: string;
  locale: string;
  timezone: string;
  currency: string;
  week: string;
  hours: string;
  password: string;
  timeout: string;
  mfa: string;
  ips: string;
  schedule: string;
  retention: string;
  version: string;
  previous: string;
  tier: string;
  expiry: string;
};
type Snapshot = { id: string; name: string; date: string; settings: Settings };
const initial: Settings = {
  name: "Riverside Services",
  logo: "RS",
  locale: "English (Philippines)",
  timezone: "Asia/Manila",
  currency: "PHP",
  week: "Monday",
  hours: "09:00–18:00",
  password: "12 characters + mixed case",
  timeout: "60 minutes",
  mfa: "Optional",
  ips: "192.0.2.0/24",
  schedule: "Daily at 02:00",
  retention: "30 days",
  version: "1.4.2",
  previous: "",
  tier: "Team",
  expiry: "2027-09-11",
};
export default function SampleManage() {
  const [people] = useSampleState<Person[]>("access-people", initialPeople);
  const activeUsers = people.filter((person) => person.active).length;
  const [settings, setSettings] = useSampleState<Settings>(
    "manage-settings",
    initial,
  );
  const [backups, setBackups] = useSampleState<Snapshot[]>("manage-backups", [
    {
      id: "sample-backup-initial",
      name: "Scheduled snapshot",
      date: "2026-09-11 02:00",
      settings: initial,
    },
  ]);
  const [sessions, setSessions] = useSampleState<string[]>("manage-sessions", [
    "Mara · Desktop Chrome · Manila",
    "Eli · Mobile · Quezon City",
  ]);
  const [history, setHistory] = useSampleState<string[]>("manage-history", [
    "Installed sample version 1.4.2",
  ]);
  const [tab, setTab] = useState("Organization");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => void;
  } | null>(null);
  const [preview, setPreview] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const [dummyKey, setDummyKey] = useState("SAMPLE-TEAM-2026");
  const [showChangelog, setShowChangelog] = useState(false);
  const current = draft ?? settings;
  const change = (key: keyof Settings, value: string) =>
    setDraft({ ...current, [key]: value });
  function save() {
    if (!current.name.trim()) {
      setError("Enter an organization name.");
      return;
    }
    if (
      current.ips
        .split(",")
        .some(
          (item) =>
            item.trim() &&
            !/^192\.0\.2\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?$/.test(
              item.trim(),
            ),
        )
    ) {
      setError(
        "Use comma-separated example IPv4 addresses in 192.0.2.0/24, optionally with a CIDR prefix.",
      );
      return;
    }
    setSettings(current);
    setDraft(null);
    setError("");
    setNotice("Sample settings saved. No live policy was changed.");
  }
  const settingActions = (
    <Actions
      onCancel={() => {
        setDraft(null);
        setError("");
      }}
      save="Save sample settings"
    />
  );
  const panel = "rounded-lg border p-5 sm:p-6";
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Manage</h1>
          <p className="text-muted-foreground mt-2">
            Configure organization settings, security, and maintenance.
          </p>
        </div>
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <ShieldCheck className="size-4" />
          Sample administration
        </p>
      </header>
      <Tabs
        names={[
          "Organization",
          "Security",
          "Audit",
          "Backup",
          "Updates",
          "Licensing",
        ]}
        current={tab}
        set={(name) => {
          setTab(name);
          setDraft(null);
          setError("");
        }}
      />
      {notice && (
        <p
          role="status"
          className="bg-muted rounded-md border px-4 py-3 text-sm"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-destructive rounded-md border px-4 py-3 text-sm"
        >
          {error}
        </p>
      )}
      {tab === "Organization" && (
        <Section
          title="Organization"
          description="Identity and defaults for your sample workspace."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
            className="grid gap-6 lg:grid-cols-[240px_1fr]"
          >
            <aside className="space-y-4">
              <div className="bg-muted flex size-20 items-center justify-center rounded-2xl border text-2xl font-semibold">
                {current.logo === "Compass" ? (
                  <Building2 className="size-8" />
                ) : (
                  current.logo
                )}
              </div>
              <h3 className="font-medium">{current.name}</h3>
              <p className="text-muted-foreground text-sm">
                Choose a bundled logo style. No image is uploaded.
              </p>
            </aside>
            <div className={`${panel} space-y-5`}>
              <Field
                label="Organization name"
                required
                value={current.name}
                onChange={(event) => change("name", event.target.value)}
              />
              <Choice
                label="Organization logo"
                value={current.logo}
                options={["RS", "R", "Compass"]}
                onChange={(value) => change("logo", value)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Choice
                  label="Locale"
                  value={current.locale}
                  options={[
                    "English (Philippines)",
                    "Filipino",
                    "English (US)",
                  ]}
                  onChange={(value) => change("locale", value)}
                />
                <Choice
                  label="Timezone"
                  value={current.timezone}
                  options={["Asia/Manila", "UTC", "Asia/Singapore"]}
                  onChange={(value) => change("timezone", value)}
                />
                <Choice
                  label="Currency"
                  value={current.currency}
                  options={["PHP", "USD", "SGD"]}
                  onChange={(value) => change("currency", value)}
                />
                <Choice
                  label="Week starts on"
                  value={current.week}
                  options={["Monday", "Sunday"]}
                  onChange={(value) => change("week", value)}
                />
              </div>
              <Field
                label="Business hours"
                value={current.hours}
                onChange={(event) => change("hours", event.target.value)}
              />
              {settingActions}
            </div>
          </form>
        </Section>
      )}
      {tab === "Security" && (
        <Section
          title="Security policies"
          description="Explore policy configuration with dummy settings. No passwords, tokens or authentication codes are collected."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              className={`${panel} space-y-5`}
            >
              <h3 className="font-semibold">Account protection</h3>
              <Choice
                label="Password policy"
                value={current.password}
                options={[
                  "12 characters + mixed case",
                  "16 characters + mixed case + number",
                  "20-character passphrase",
                ]}
                onChange={(value) => change("password", value)}
              />
              <Choice
                label="Session timeout"
                value={current.timeout}
                options={["15 minutes", "30 minutes", "60 minutes", "8 hours"]}
                onChange={(value) => change("timeout", value)}
              />
              <Choice
                label="Two-factor authentication"
                value={current.mfa}
                options={[
                  "Optional",
                  "Required for administrators",
                  "Required for everyone",
                ]}
                onChange={(value) => change("mfa", value)}
              />
              <Field
                label="Sample IP allow list"
                placeholder="192.0.2.0/24"
                value={current.ips}
                onChange={(event) => change("ips", event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Comma-separated documentation addresses only. An empty list
                means unrestricted in this sample.
              </p>
              {settingActions}
            </form>
            <div className={`${panel} space-y-4`}>
              <h3 className="font-semibold">Active sample sessions</h3>
              {sessions.map((session) => (
                <div key={session} className="space-y-3 border-b py-3">
                  <p className="text-sm">{session}</p>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() =>
                      setConfirm({
                        title: "End sample session",
                        description: `${session} will be removed from this sample session list. Your real session stays active.`,
                        action: () => {
                          setSessions((items) =>
                            items.filter((item) => item !== session),
                          );
                          setNotice("Sample session ended.");
                        },
                      })
                    }
                  >
                    End session · {session.split(" · ")[0]}
                  </Button>
                </div>
              ))}
              {!sessions.length && (
                <p className="text-muted-foreground text-sm">
                  No active sample sessions.
                </p>
              )}
              <div className="bg-muted rounded-md p-4 text-sm">
                <h4 className="font-medium">Enrollment preview</h4>
                <p className="text-muted-foreground mt-2">
                  Select a two-factor policy, then preview the sample enrollment
                  steps.
                </p>
                <Button
                  variant="outline"
                  className="mt-3 min-h-11"
                  onClick={() =>
                    setPreview({
                      title: "Sample MFA enrollment",
                      body: `Policy: ${current.mfa}\n1. Choose an authenticator or security key.\n2. Verify the selected factor.\n3. Store recovery options securely.\nThis preview does not enroll a real factor or generate recovery codes.`,
                    })
                  }
                >
                  Preview MFA setup
                </Button>
              </div>
            </div>
          </div>
        </Section>
      )}
      {tab === "Audit" && <SampleAudit />}
      {tab === "Backup" && (
        <Section
          title="Backup & recovery"
          description="Snapshots demonstrate configuration recovery. No application records or real database files are copied."
        >
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div className={panel}>
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold">Snapshot history</h3>
                <Button
                  className="min-h-11"
                  onClick={() => {
                    setBackups((list) => [
                      {
                        id: `sample-backup-${crypto.randomUUID()}`,
                        name: list.some(
                          (item) => item.name === "Manual snapshot",
                        )
                          ? `Manual snapshot ${list.length}`
                          : "Manual snapshot",
                        date: new Date().toLocaleString(),
                        settings: { ...settings },
                      },
                      ...list,
                    ]);
                    setNotice(
                      "Sample snapshot created with the current organization and policy settings.",
                    );
                  }}
                >
                  <HardDrive />
                  Create sample backup
                </Button>
              </div>
              <div className="divide-y">
                {backups.map((backup) => (
                  <div key={backup.id} className="space-y-3 py-4">
                    <div>
                      <p className="font-medium">{backup.name}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {backup.date} · Configuration only · Complete
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        className="min-h-11"
                        aria-label={`Restore ${backup.name}`}
                        onClick={() =>
                          setConfirm({
                            title: "Sample restore",
                            description: `Restore organization name, locale, policies and settings from ${backup.name}? This replaces current sample settings only.`,
                            action: () => {
                              setSettings({ ...backup.settings });
                              setDraft(null);
                              setNotice(
                                `Restored sample snapshot: ${backup.name}.`,
                              );
                            },
                          })
                        }
                      >
                        Restore
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-11"
                        aria-label={`Download preview ${backup.name}`}
                        onClick={() =>
                          setPreview({
                            title: "Backup download preview",
                            body: `Sample archive: ${backup.id}.json\nContents: organization settings, policy settings, version and license state.\n${JSON.stringify(backup.settings, null, 2)}\nPreview only. No file was downloaded.`,
                          })
                        }
                      >
                        Download preview
                        <ArrowUpRight />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
              className={`${panel} h-fit space-y-5`}
            >
              <h3 className="font-semibold">Automatic backups</h3>
              <Choice
                label="Backup schedule"
                value={current.schedule}
                options={[
                  "Disabled",
                  "Daily at 02:00",
                  "Weekly on Sunday at 02:00",
                ]}
                onChange={(value) => change("schedule", value)}
              />
              <Choice
                label="Retention period"
                value={current.retention}
                options={["7 days", "30 days", "90 days"]}
                onChange={(value) => change("retention", value)}
              />
              <p className="text-muted-foreground text-sm">
                Schedule and retention are saved as sample configuration; no
                background job runs.
              </p>
              {settingActions}
            </form>
          </div>
        </Section>
      )}
      {tab === "Updates" && (
        <Section
          title="Updates"
          description="Review a release before making a sample version change."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div className={`${panel} space-y-5`}>
              <p className="text-xs font-medium tracking-widest uppercase">
                Release channel · Stable
              </p>
              <h3 className="text-2xl font-semibold">
                Current version · {settings.version}
              </h3>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setUpdateAvailable(settings.version !== "1.5.0");
                  setNotice(
                    settings.version === "1.5.0"
                      ? "Sample version is up to date."
                      : "Sample release 1.5.0 is available.",
                  );
                }}
              >
                Check for updates
              </Button>
              {updateAvailable && settings.version !== "1.5.0" && (
                <div className="bg-muted space-y-3 rounded-md p-4">
                  <h4 className="font-semibold">1.5.0 · Available</h4>
                  <p className="text-muted-foreground text-sm">
                    Refined navigation, improved report layouts and clearer
                    session controls.
                  </p>
                  <Button
                    className="min-h-11"
                    onClick={() =>
                      setConfirm({
                        title: "Sample update",
                        description: `Update sample version ${settings.version} to 1.5.0? This updates the visible version and keeps a rollback point. No software is installed.`,
                        action: () => {
                          setSettings((value) => ({
                            ...value,
                            previous: value.version,
                            version: "1.5.0",
                          }));
                          setHistory((list) => [
                            "Applied sample version 1.5.0",
                            ...list,
                          ]);
                          setUpdateAvailable(false);
                          setNotice("Sample update applied.");
                        },
                      })
                    }
                  >
                    Apply sample update
                  </Button>
                </div>
              )}
              <Button
                variant="ghost"
                className="min-h-11"
                onClick={() => setShowChangelog(!showChangelog)}
              >
                View changelog
              </Button>
              {showChangelog && (
                <div className="space-y-2 border-t pt-4 text-sm">
                  <h4 className="font-semibold">1.5.0 release notes</h4>
                  <ul className="text-muted-foreground list-inside list-disc space-y-2">
                    <li>Six-pillar workspace navigation</li>
                    <li>Mobile-friendly report inspectors</li>
                    <li>Improved session management clarity</li>
                  </ul>
                </div>
              )}
              {settings.previous && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() =>
                    setConfirm({
                      title: "Sample rollback",
                      description: `Return the sample version to ${settings.previous}?`,
                      action: () => {
                        setHistory((list) => [
                          `Rolled back sample version to ${settings.previous}`,
                          ...list,
                        ]);
                        setSettings((value) => ({
                          ...value,
                          version: value.previous,
                          previous: "",
                        }));
                        setNotice("Sample update rolled back.");
                      },
                    })
                  }
                >
                  Roll back update
                </Button>
              )}
            </div>
            <div className={panel}>
              <h3 className="mb-5 font-semibold">Release history</h3>
              <ol className="space-y-4">
                {history.map((item, index) => (
                  <li
                    className="border-l-2 pl-4 text-sm"
                    key={`${index}-${item}`}
                  >
                    {item}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Section>
      )}
      {tab === "Licensing" && (
        <Section
          title="License & usage"
          description="Illustrative tiers and limits. No payment, subscription or license service is connected."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div className={`${panel} space-y-5`}>
              <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
                Current sample plan
              </p>
              <h3 className="text-3xl font-semibold">{settings.tier}</h3>
              <p className="text-sm">Expires {settings.expiry}</p>
              <div>
                <div className="mb-2 flex justify-between text-sm">
                  <span>Users</span>
                  <span>
                    {activeUsers} /{" "}
                    {settings.tier === "Business" ? "100" : "25"}
                  </span>
                </div>
                <progress
                  aria-label="User license usage"
                  className="accent-foreground h-2 w-full"
                  value={activeUsers}
                  max={settings.tier === "Business" ? 100 : 25}
                />
              </div>
              <div>
                <div className="mb-2 flex justify-between text-sm">
                  <span>Storage</span>
                  <span>
                    1.2 / {settings.tier === "Business" ? "100" : "10"} GB
                  </span>
                </div>
                <progress
                  aria-label="Storage license usage"
                  className="accent-foreground h-2 w-full"
                  value={1.2}
                  max={settings.tier === "Business" ? 100 : 10}
                />
              </div>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() =>
                  setConfirm({
                    title: "Sample renewal",
                    description:
                      "Extend the sample expiration date by one year. No purchase or payment will occur.",
                    action: () => {
                      const date = new Date(`${settings.expiry}T12:00:00Z`);
                      date.setUTCFullYear(date.getUTCFullYear() + 1);
                      setSettings((value) => ({
                        ...value,
                        expiry: date.toISOString().slice(0, 10),
                      }));
                      setNotice(
                        "Sample license renewed for one year. No payment was made.",
                      );
                    },
                  })
                }
              >
                Renew sample license
              </Button>
            </div>
            <form
              className={`${panel} h-fit space-y-4`}
              onSubmit={(event) => {
                event.preventDefault();
                setConfirm({
                  title: "Sample activation",
                  description: `Activate the bundled ${dummyKey.includes("BUSINESS") ? "Business" : "Team"} license in this sample?`,
                  action: () => {
                    setSettings((value) => ({
                      ...value,
                      tier: dummyKey.includes("BUSINESS") ? "Business" : "Team",
                    }));
                    setNotice("Bundled sample license activated.");
                  },
                });
              }}
            >
              <h3 className="font-semibold">Activate a license</h3>
              <Choice
                label="Bundled dummy license key"
                value={dummyKey}
                options={["SAMPLE-TEAM-2026", "SAMPLE-BUSINESS-2026"]}
                onChange={setDummyKey}
              />
              <p className="text-muted-foreground text-sm">
                Select a bundled dummy key. Do not enter a real license key.
              </p>
              <Check
                label="Show license terms"
                checked={preview?.title === "Sample license terms"}
                onChange={(checked) =>
                  setPreview(
                    checked
                      ? {
                          title: "Sample license terms",
                          body: "Illustrative license only. Team: 25 users / 10 GB. Business: 100 users / 100 GB. These figures demonstrate the interface and are not an offer or a published OpenSlate plan.",
                        }
                      : null,
                  )
                }
              />
              <Button type="submit" className="min-h-11">
                Activate sample license
              </Button>
            </form>
          </div>
        </Section>
      )}
      <Editor
        title={confirm?.title ?? "Confirm"}
        open={confirm !== null}
        onClose={() => setConfirm(null)}
      >
        {confirm && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              confirm.action();
              setConfirm(null);
            }}
          >
            <p className="text-muted-foreground text-sm leading-relaxed">
              {confirm.description}
            </p>
            <Actions
              onCancel={() => setConfirm(null)}
              save={`Confirm ${confirm.title.toLowerCase()}`}
            />
          </form>
        )}
      </Editor>
      <Editor
        title={preview?.title ?? "Preview"}
        open={preview !== null}
        onClose={() => setPreview(null)}
      >
        <pre className="bg-muted max-h-96 overflow-auto rounded-md p-4 text-xs leading-relaxed whitespace-pre-wrap">
          {preview?.body}
        </pre>
        <Button
          className="mt-5 min-h-11"
          variant="outline"
          onClick={() => setPreview(null)}
        >
          Close preview
        </Button>
      </Editor>
    </div>
  );
}
