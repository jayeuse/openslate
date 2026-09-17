"use client";
import {
  KeyRound,
  Monitor,
  Search,
  Smartphone,
  UsersRound,
} from "lucide-react";
import { type MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ManageSession } from "./sessions";
import {
  SettingSelect,
  SettingInput,
  SettingActions,
  SectionHeading,
  type SettingsPanelForm,
} from "./panel-ui";
type SecurityPanelProps = {
  form: SettingsPanelForm;
  panelClass: string;
  sessionList: {
    sessions: ManageSession[];
    sessionSearch: string;
    setSessionSearch: import("react").Dispatch<
      import("react").SetStateAction<string>
    >;
    setSessionPage: import("react").Dispatch<
      import("react").SetStateAction<number>
    >;
    remoteSessions: ManageSession[];
    visibleSessions: ManageSession[];
    visibleSessionRows: readonly ManageSession[];
    firstVisibleSession: number;
    lastVisibleSession: number;
    sessionPageCount: number;
    safeSessionPage: number;
  };
  actions: {
    openMfa: (event?: MouseEvent<HTMLButtonElement>) => void;
    endAllRemoteSessions: (event: MouseEvent<HTMLElement>) => void;
    endSession: (
      session: ManageSession,
      event: MouseEvent<HTMLElement>,
    ) => void;
  };
};
export function SecurityPanel({
  form,
  panelClass,
  sessionList,
  actions,
}: SecurityPanelProps) {
  const { dirty, saveSection, current, errors, changeSetting, clearDraft } =
    form;
  const {
    sessions,
    sessionSearch,
    setSessionSearch,
    setSessionPage,
    remoteSessions,
    visibleSessions,
    visibleSessionRows,
    firstVisibleSession,
    lastVisibleSession,
    sessionPageCount,
    safeSessionPage,
  } = sessionList;
  const { openMfa, endAllRemoteSessions, endSession } = actions;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="manage-security-heading"
    >
      <SectionHeading
        title="Security policies"
        description="Explore account protection settings and local sessions. No passwords, tokens or authentication codes are collected."
        dirty={dirty}
      />
      <div className="grid gap-3 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        <Card className={panelClass}>
          <CardHeader>
            <CardTitle id="manage-security-heading">
              Account protection
            </CardTitle>
            <CardDescription>
              These options describe a future policy surface and have no
              enforcement without a live policy service.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                saveSection("security");
              }}
            >
              <SettingSelect
                id="password-policy"
                label="Password policy"
                value={current.password}
                error={errors.password}
                options={[
                  "12 characters + mixed case",
                  "16 characters + mixed case + number",
                  "20-character passphrase",
                ]}
                onChange={(value) =>
                  changeSetting("security", "password", value)
                }
              />
              <SettingSelect
                id="session-timeout"
                label="Session timeout"
                value={current.timeout}
                error={errors.timeout}
                options={["15 minutes", "30 minutes", "60 minutes", "8 hours"]}
                onChange={(value) =>
                  changeSetting("security", "timeout", value)
                }
              />
              <SettingSelect
                id="mfa-policy"
                label="Two-factor authentication"
                value={current.mfa}
                error={errors.mfa}
                options={[
                  "Optional",
                  "Required for administrators",
                  "Required for everyone",
                ]}
                onChange={(value) => changeSetting("security", "mfa", value)}
                description="Use the enrollment preview to understand the local flow."
              />
              <SettingInput
                id="sample-ip-allow-list"
                label="IP allow list"
                value={current.ips}
                onChange={(value) => changeSetting("security", "ips", value)}
                placeholder="192.0.2.0/24"
                error={errors.ips ?? null}
                description="Comma-separated documentation addresses only. An empty list means unrestricted locally."
              />
              <SettingActions
                dirty={dirty}
                onDiscard={() => clearDraft("security")}
                onSave={() => saveSection("security")}
              />
            </form>
          </CardContent>
        </Card>
        <Card className={panelClass}>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Active sessions</CardTitle>
              <CardDescription className="md:sr-only">
                Inspect devices and end remote sessions while keeping the
                current session safe.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{sessions.length} active</Badge>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={openMfa}
              >
                <KeyRound data-icon="inline-start" /> Preview MFA setup
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Field>
              <FieldLabel htmlFor="search-sessions">Search sessions</FieldLabel>
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                  aria-hidden="true"
                />
                <Input
                  id="search-sessions"
                  value={sessionSearch}
                  onChange={(event) => {
                    setSessionSearch(event.target.value);
                    setSessionPage(1);
                  }}
                  className="min-h-11 pl-10 sm:min-h-9"
                  placeholder="Person, device or location"
                />
              </div>
            </Field>
            {remoteSessions.length ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                onClick={endAllRemoteSessions}
              >
                <UsersRound data-icon="inline-start" /> End all remote sessions
              </Button>
            ) : null}
            {visibleSessions.length ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Session</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleSessionRows.map((session) => (
                      <TableRow key={session.id}>
                        <TableCell className="whitespace-normal">
                          <div className="flex min-w-44 items-start gap-3">
                            <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
                              {session.device === "Mobile" ? (
                                <Smartphone aria-hidden="true" />
                              ) : (
                                <Monitor aria-hidden="true" />
                              )}
                            </div>
                            <div>
                              <p className="font-medium">
                                {session.personName} · {session.device} ·{" "}
                                {session.browser}
                              </p>
                              <p className="text-muted-foreground mt-1 text-xs">
                                Last seen {session.lastSeen}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm whitespace-normal">
                          {session.location}
                        </TableCell>
                        <TableCell>
                          {session.current ? (
                            <Badge variant="success">Current session</Badge>
                          ) : (
                            <Badge variant="outline">Remote</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!session.current ? (
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11"
                              aria-label={`End session · ${session.personName}`}
                              onClick={(event) => endSession(session, event)}
                            >
                              End
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                  <p className="text-muted-foreground text-sm">
                    Showing {firstVisibleSession}–{lastVisibleSession} of{" "}
                    {visibleSessions.length} sessions
                  </p>
                  {sessionPageCount > 1 ? (
                    <Pagination
                      aria-label="Session pages"
                      className="mx-0 w-auto justify-start sm:justify-end"
                    >
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            href="#active-sessions"
                            aria-disabled={safeSessionPage === 1}
                            tabIndex={safeSessionPage === 1 ? -1 : undefined}
                            className={
                              safeSessionPage === 1
                                ? "pointer-events-none opacity-50"
                                : undefined
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              if (safeSessionPage > 1)
                                setSessionPage(safeSessionPage - 1);
                            }}
                          />
                        </PaginationItem>
                        <PaginationItem>
                          <PaginationLink
                            href="#active-sessions"
                            size="default"
                            isActive
                            aria-label={`Session page ${safeSessionPage} of ${sessionPageCount}`}
                            onClick={(event) => event.preventDefault()}
                          >
                            {safeSessionPage} / {sessionPageCount}
                          </PaginationLink>
                        </PaginationItem>
                        <PaginationItem>
                          <PaginationNext
                            href="#active-sessions"
                            aria-disabled={safeSessionPage === sessionPageCount}
                            tabIndex={
                              safeSessionPage === sessionPageCount
                                ? -1
                                : undefined
                            }
                            className={
                              safeSessionPage === sessionPageCount
                                ? "pointer-events-none opacity-50"
                                : undefined
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              if (safeSessionPage < sessionPageCount)
                                setSessionPage(safeSessionPage + 1);
                            }}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  ) : null}
                </div>
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Monitor aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No sessions match this search</EmptyTitle>
                  <EmptyDescription>
                    Clear the search to view all active sessions.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
