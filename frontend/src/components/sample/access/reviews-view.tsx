"use client";

import { useState } from "react";
import { ClipboardCheck, Plus, UserCheck } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import type { AccessController } from "./controller";
import type { AccessReview } from "./policy";

export type ReviewsViewProps = { controller: AccessController };
type ReviewSubjectKind = AccessReview["subjectKind"];
type ReviewDecision = Exclude<
  AccessReview["decisions"][number]["decision"],
  "pending"
>;

const reviewKinds: { value: ReviewSubjectKind; label: string }[] = [
  { value: "role", label: "Role" },
  { value: "group", label: "Group" },
  { value: "identity-kind", label: "Identity type" },
  { value: "expiry-window", label: "Expiry window" },
];

export function ReviewsView({ controller }: ReviewsViewProps) {
  const { state, actions } = controller;
  const administratorRole = state.roles.find(
    (role) => role.id === "sample-admin",
  );
  const reviewers = state.identities.filter(
    (identity) =>
      identity.kind === "internal" &&
      identity.status === "active" &&
      identity.roleId === administratorRole?.id,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [subjectKind, setSubjectKind] = useState<ReviewSubjectKind>("role");
  const [subjectId, setSubjectId] = useState(state.roles[0]?.id ?? "");
  const [reviewerId, setReviewerId] = useState(reviewers[0]?.id ?? "");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function optionsFor(kind: ReviewSubjectKind) {
    if (kind === "role")
      return state.roles.map(({ id, name }) => ({ id, name }));
    if (kind === "group")
      return state.groups.map(({ id, name }) => ({ id, name }));
    if (kind === "identity-kind")
      return [
        { id: "internal", name: "Internal people" },
        { id: "guest", name: "Guests" },
        { id: "service", name: "Service identities" },
      ];
    return [
      { id: "7", name: "Expires within 7 days" },
      { id: "30", name: "Expires within 30 days" },
      { id: "90", name: "Expires within 90 days" },
      { id: "expired", name: "Already expired" },
    ];
  }

  function targetName(id: string): string {
    return (
      state.identities.find((identity) => identity.id === id)?.name ??
      state.roles.find((role) => role.id === id)?.name ??
      state.groups.find((group) => group.id === id)?.name ??
      id
    );
  }

  async function createCampaign() {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const targetIds = (() => {
      if (subjectKind === "role")
        return state.identities
          .filter((identity) => identity.roleId === subjectId)
          .map((identity) => identity.id);
      if (subjectKind === "group")
        return (
          state.groups.find((group) => group.id === subjectId)?.memberIds ?? []
        );
      if (subjectKind === "identity-kind")
        return state.identities
          .filter((identity) => identity.kind === subjectId)
          .map((identity) => identity.id);
      const now = Date.now();
      return state.identities
        .filter((identity) => {
          if (!identity.expiresAt) return false;
          const expiresAt = Date.parse(identity.expiresAt);
          if (!Number.isFinite(expiresAt)) return false;
          if (subjectId === "expired") return expiresAt <= now;
          const windowDays = Number(subjectId);
          return expiresAt > now && expiresAt <= now + windowDays * 86_400_000;
        })
        .map((identity) => identity.id);
    })();
    const result = await actions.createReviewCampaign({
      name: name.trim(),
      reviewerId,
      subjectKind,
      subjectId,
      targetIds,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreateOpen(false);
    setName("");
    setError("");
    setNotice("Review campaign created.");
  }

  async function recordDecision(
    reviewId: string,
    targetId: string,
    decision: ReviewDecision,
  ) {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const result = await actions.recordReviewDecision(
      reviewId,
      targetId,
      decision,
    );
    if (!result.ok) setError(result.error);
    else {
      setError("");
      setNotice(`Recorded ${decision} for ${targetName(targetId)}.`);
    }
  }

  async function completeCampaign(review: AccessReview) {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const result = await actions.completeReview(review.id);
    if (!result.ok) setError(result.error);
    else {
      setError("");
      setNotice(`${review.name} completed.`);
    }
  }

  return (
    <section aria-labelledby="reviews-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="reviews-title"
            className="text-xl font-semibold tracking-tight"
          >
            Access reviews
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Run certification campaigns and resolve every access decision before
            completion.
          </p>
        </div>
        <Button
          type="button"
          className="min-h-11"
          disabled={!reviewers.length || controller.isPending()}
          onClick={() => setCreateOpen(true)}
        >
          <Plus aria-hidden="true" data-icon="inline-start" /> Create campaign
        </Button>
      </div>

      {!reviewers.length ? (
        <Alert variant="warning">
          A review requires an active internal Administrator reviewer. Guests
          and service identities cannot review access.
        </Alert>
      ) : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}
      {error ? (
        <Alert role="alert" variant="destructive">
          {error}
        </Alert>
      ) : null}

      {!state.reviews.length ? (
        <Empty className="min-h-64 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardCheck aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No review campaigns</EmptyTitle>
            <EmptyDescription>
              Create a role, group, identity-type, or expiry-window review.
              Campaigns remain available in the workspace.
            </EmptyDescription>
          </EmptyHeader>
          {reviewers.length ? (
            <EmptyContent>
              <Button
                type="button"
                className="min-h-11"
                disabled={controller.isPending()}
                onClick={() => setCreateOpen(true)}
              >
                Create first campaign
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {state.reviews.map((review) => {
            const unresolved = review.decisions.filter(
              (item) => item.decision === "pending",
            ).length;
            const reviewer = state.identities.find(
              (identity) => identity.id === review.reviewerId,
            );
            return (
              <Card key={review.id} role="article">
                <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <CardTitle>{review.name}</CardTitle>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {
                        reviewKinds.find(
                          (kind) => kind.value === review.subjectKind,
                        )?.label
                      }{" "}
                      · {targetName(review.subjectId)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={
                        review.status === "complete" ? "success" : "secondary"
                      }
                    >
                      {review.status}
                    </Badge>
                    <Badge variant={unresolved ? "warning" : "outline"}>
                      {unresolved} unresolved
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="flex items-center gap-2 text-sm">
                    <UserCheck aria-hidden="true" className="size-4" />{" "}
                    Reviewer: {reviewer?.name ?? "Unknown administrator"}
                  </p>
                  {review.decisions.length ? (
                    <div className="divide-y rounded-lg border">
                      {review.decisions.map((item) => (
                        <div
                          key={item.targetId}
                          className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between"
                        >
                          <div>
                            <p className="font-medium">
                              {targetName(item.targetId)}
                            </p>
                            <p className="text-muted-foreground text-xs">
                              Current decision: {item.decision}
                            </p>
                          </div>
                          <ToggleGroup
                            aria-label={`${targetName(item.targetId)} review decision`}
                            value={
                              item.decision === "pending" ? [] : [item.decision]
                            }
                            disabled={
                              review.status === "complete" ||
                              controller.isPending()
                            }
                            onValueChange={(values) => {
                              const decision = values[0] as
                                ReviewDecision | undefined;
                              if (decision)
                                void recordDecision(
                                  review.id,
                                  item.targetId,
                                  decision,
                                );
                            }}
                            variant="outline"
                            spacing={0}
                            className="w-full md:w-auto [&>button]:min-h-11 [&>button]:flex-1"
                          >
                            <ToggleGroupItem value="keep">Keep</ToggleGroupItem>
                            <ToggleGroupItem value="change">
                              Change
                            </ToggleGroupItem>
                            <ToggleGroupItem value="revoke">
                              Revoke
                            </ToggleGroupItem>
                          </ToggleGroup>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Alert variant="warning">
                      No matching targets were captured for this campaign.
                    </Alert>
                  )}
                  {review.status !== "complete" ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                      <p className="text-muted-foreground text-sm">
                        Completion is blocked until all{" "}
                        {review.decisions.length} decisions are resolved.
                      </p>
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={
                          unresolved > 0 ||
                          review.decisions.length === 0 ||
                          controller.isPending()
                        }
                        onClick={() => completeCampaign(review)}
                      >
                        Complete campaign
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create access review</DialogTitle>
            <DialogDescription>
              Only an active internal Administrator can be selected as reviewer.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field>
              <FieldLabel htmlFor="review-name">Campaign name</FieldLabel>
              <Input
                id="review-name"
                className="min-h-11"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Quarterly operations review"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="review-type">Review by</FieldLabel>
              <NativeSelect
                id="review-type"
                className="w-full [&>select]:min-h-11"
                value={subjectKind}
                onChange={(event) => {
                  const kind = event.target.value as ReviewSubjectKind;
                  setSubjectKind(kind);
                  setSubjectId(optionsFor(kind)[0]?.id ?? "");
                }}
              >
                {reviewKinds.map((kind) => (
                  <NativeSelectOption key={kind.value} value={kind.value}>
                    {kind.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="review-subject">Review scope</FieldLabel>
              <NativeSelect
                id="review-subject"
                className="w-full [&>select]:min-h-11"
                value={subjectId}
                onChange={(event) => setSubjectId(event.target.value)}
              >
                {optionsFor(subjectKind).map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {option.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="reviewer">
                Internal Administrator reviewer
              </FieldLabel>
              <NativeSelect
                id="reviewer"
                className="w-full [&>select]:min-h-11"
                value={reviewerId}
                onChange={(event) => setReviewerId(event.target.value)}
              >
                {reviewers.map((reviewer) => (
                  <NativeSelectOption key={reviewer.id} value={reviewer.id}>
                    {reviewer.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                Guests, services, and non-administrator identities are excluded.
              </FieldDescription>
            </Field>
            {error ? (
              <Alert role="alert" variant="destructive">
                {error}
              </Alert>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={
                !name.trim() ||
                !subjectId ||
                !reviewerId ||
                controller.isPending()
              }
              onClick={createCampaign}
            >
              Create campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
