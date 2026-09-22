# Sandbox Manual Acceptance Guide

## Purpose

Use this guide to verify the complete low-tech Sandbox journey: **Build →
Automations → Test → History → Review & Publish**. A successful run proves that
the shared draft, history, temporary test evidence, and published live structure
all use PostgreSQL. Templates and tests must never create operational records.

Run destructive checks only against a disposable local workspace. If the draft
matters, export it first from **More Sandbox actions → Import or export**.

## 1. Empty-state and navigation check

1. Open `/sandbox` in a fresh disposable database.
2. Confirm the page shows an empty organization builder: no departments,
   modules, fields, relationships, automations, test results, or history.
3. Confirm the only main work areas are **Build**, **Automations**, **Test**, and
   **History**.
4. Confirm the primary action is **Review & Publish**. The secondary menu should
   contain **Start from template**, **Save checkpoint**, **Import or export**,
   and **Discard draft changes**.
5. Reload the page. The empty state must remain empty; no sample organization or
   sample records may appear.

## 2. Build from scratch

| Action | Expected success |
| --- | --- |
| Create an `Operations` department. | It appears in the structure panel and graph; reload retains it. |
| Add `Inventory` and `Suppliers` modules. | Both appear under Operations and as graph cards. |
| Add required `SKU` and `Supplier name` text fields, numeric `Unit cost`, select `Status`, and date `Last reviewed`. | Each type and setting remains correct after reload. |
| Reorder two fields, rename one, and move one module inside its department. | Structure, graph, and inspector stay synchronized. |
| Connect Suppliers to Inventory with a one-to-many relationship. | The graph shows one link and the relationship appears in both module inspectors. |
| Undo, redo, zoom, fit, center, collapse, expand, search, and jump to selection. | Every control visibly changes the current view or draft and never creates live records. |

## 3. Automation authoring

1. Open **Automations** and create an enabled automation for Inventory.
2. Choose **A field changes**, select `Status`, add a same-record condition, and
   use **Set field** as the action.
3. Save it, reload, and confirm its trigger, condition, action, and enabled
   state remain present.
4. Edit without saving and try to leave the section. Navigation must be blocked
   until the edit is saved or discarded.
5. Create one daily or weekly schedule. It must require a module. Verify its
   timezone and worker timing with the guarded command in the technical appendix,
   not a hidden UI setting.

Only the supported plain-language subset may publish: item added, field changed,
number threshold, or schedule; same-record conditions; and Set field actions.
Imported unsupported actions must remain visible and removable, and must block
publishing rather than being silently changed.

## 4. Temporary Test workspace

1. Open **Test**, choose a module, enter temporary field values, and select an
   event.
2. Run the test. Confirm the result lists field validation, relationship routes,
   and automation outcomes using names rather than internal IDs.
3. Test all four event types: item added, field changed, number threshold, and
   schedule.
4. Reload and confirm recent results remain available. Create 50 runs, then
   confirm run 51 is rejected with a plain-language history-full message.
5. Select **Clear results**, confirm only test evidence disappears, then run one
   more test successfully.

Before and after this section, compare operational `records` and
`relationship_edges` counts. They must be identical.

## 5. Checkpoints, compare, restore, import, and export

| Action | Expected success |
| --- | --- |
| Save a named checkpoint. | History shows it with its note and timestamp. |
| Save a second checkpoint after changing a field, then compare the two checkpoints. | The comparison names the changed item and property. |
| Restore the checkpoint. | A new draft revision is created with the checkpoint content. |
| Rename or delete a checkpoint. | The change persists; a published version remains immutable. |
| Export JSON. | The downloaded file is formatted, schema version 2, and contains structure and automations but no business records. |
| Import the same JSON. | The draft is replaced atomically and an imported history entry is created. |
| Discard draft changes. | A safety checkpoint is created first; the latest published design is restored, or an empty draft is used when nothing has been published. |

## 6. Organization templates

Repeat this for Inventory & procurement; Finance, accounting & sales; Retail &
commerce; Professional services; Field service & maintenance; and Light
manufacturing.

1. Open **Start from template**, select a card, and inspect the displayed
   department, module, field, relationship, and automation counts. Selection
   alone must not modify the shared draft.
2. Choose **Use template**. Confirm the draft changes and an imported history
   entry appears.
3. Reload and inspect at least one field, relationship, and automation.
4. Run one temporary test.
5. Complete **Review & Publish**. Every built-in template must be publishable;
   template relationships must remain inside their department because that is
   the live relationship boundary.
6. Confirm no operational records or relationship edges were created.

## 7. Review and publish

1. Select **Review & Publish**, then **Review changes**.
2. Confirm the review names every create, update, close, reopen, and automation
   change. It must not expose internal IDs as the primary label.
3. Enter the current administrator password and publish once.
4. Confirm the header reports **Published**, History contains an immutable
   published version, and the operational department/module/field/relationship
   and published-automation tables contain the matching structure.
5. Run the publication concurrency check in the technical appendix. It proves
   that repeating the same idempotency key returns the same publication instead
   of creating a duplicate.
6. Create or update a real record through the operational API. Confirm a matching
   published automation changes the record when conditions match, produces one
   recent run, and writes audit history as the original publisher.
7. Disable the publisher or remove `records.write`, then trigger another run.
   The definition must suspend with a clear reason and the record must remain
   unchanged.

## 8. Expected failures and data guarantees

| Condition | Expected response | Data guarantee |
| --- | --- | --- |
| Blank name, invalid select options, invalid field settings, duplicate ID, or missing reference. | The relevant form or review identifies what must be fixed. | No partial live write. |
| Relationship crosses departments, points to the same module, or conflicts with unmanaged live fields. | Review blocks publishing and names the affected item. | Existing live structure remains unchanged. |
| Automation has no action, crosses modules, uses a relationship-based field reference, or contains an unsupported action. | Review blocks publishing with plain-language guidance. | No automation definition is silently flattened or partially published. |
| Another user saves first. | A conflict prompt offers reload or reapply. | The newer revision is never overwritten silently. |
| Preview expires, live structure changes, or the same token/key is reused differently. | Publish returns the documented conflict and asks for a fresh review. | No duplicate or stale publication. |
| Password is missing or wrong, or the user lacks the required structure and records write access. | Publish is rejected without revealing credential details. | No publication or live mutation. |
| A field/module/department with live dependencies is closed. | Review blocks the close and explains that dependencies must be handled first. | Records and links are preserved. |
| Malformed/future-schema/over-5-MiB JSON is imported. | Import is rejected before replacement. | Current draft and history remain unchanged. |
| Test input is invalid or the server/network fails. | The current draft stays available; the error is recoverable. | No operational record or relationship edge is created. |
| An automation retries after an execution failure. | It uses a lease and backoff, then ends after five attempts. | One event/automation pair produces at most one run; depth and root action budget remain bounded. |

## Automated evidence

- Frontend isolated Sandbox tests cover document parsing, templates, API
  contracts, conflict-safe sessions, Build controls, Automations, Test, and
  History.
- Backend Sandbox suites cover durable design/version persistence, temporary
  test evidence, safe publication, concurrency/idempotency, and automation
  execution.
- PostgreSQL guarantees must use the guarded full-stack runner; mocked HTTP
  tests do not prove commits, rollbacks, runtime-role grants, or process-restart
  persistence.
- Final browser acceptance must exercise the real FastAPI routes against the
  disposable PostgreSQL database, not intercepted sample responses.

## Technical appendix: guarded PostgreSQL checks

Run these from `backend/`. Each command creates and destroys its own guarded,
disposable PostgreSQL database; it does not need live credentials or a manually
copied cookie.

```sh
# Publication idempotency, stale previews, and concurrent publish races.
uv run python -m tests.fullstack_runner --backend-batch --layer integration \
  tests/sandbox_publications/test_publication_integration.py \
  tests/sandbox_publications/test_concurrency_integration.py

# Timezone schedules, bounded execution, retries, publisher authorization,
# audit redaction, and recent-run persistence.
uv run python -m tests.fullstack_runner --backend-batch --layer integration \
  tests/sandbox_automations

# Complete real-browser Publish, Test, History, and all-template journey.
uv run python -m tests.fullstack_runner --acceptance-only
```

A command is successful only when the runner reports `PASS` with zero skipped
tests. Treat a skip, timeout, or missing PostgreSQL guard as unverified.
