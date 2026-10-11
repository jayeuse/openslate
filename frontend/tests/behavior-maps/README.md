# Behavior maps

A behavior map lists the behaviors of one `http` test family and the one test that owns each behavior. The frontend has no mutation runner, so the map is the proof that a consolidation keeps protection (plan item 18 in `docs/plans/test-suite-tier-2-5.md`).

## Rules

1. Keep one file for each family: `<family>.md`, for example `openview.md` or `boards.md`. The families are the work packages F1 to F8 in the plan.
2. Write the map before a change removes, merges, or moves tests in that family. Update it in the same change.
3. Give each behavior exactly one owner test. A behavior with no owner, or with two owners, is a finding to fix.
4. Name a behavior as an observable outcome, not as an implementation step.
5. Point the owner at the lowest layer that proves the behavior. An isolated test can own a rule; an `http` test owns the journey.

Correct: `| Conflict on save shows the reload banner | http | http/openview-views-api.spec.ts › conflict banner reloads the latest view | Views save contract |`
Wrong: `| setConflict is called | http | openview-views-api.spec.ts | — |`

## Format

```markdown
# <Family> behavior map

| Behavior | Layer | Owner test (file › title) | Source |
| --- | --- | --- | --- |
| <observable outcome> | isolated, http, or fullstack | <path under frontend/tests> › <test title> | <acceptance criterion, contract, or bug> |
```
