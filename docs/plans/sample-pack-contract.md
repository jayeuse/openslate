# Sample-pack contract for UI control runs

This document records the organization data each sample pack must provide so the generic runner can exercise the controls completed through Phase B using the same authenticated APIs as the UI. Harbor and School are the only packs in scope through Phase G. New packs start after Phase G, one at a time, using Harbor and School as references.

The contract follows the current action composition in `backend/operations/sample_control_actions.py::plan_controls`. The action planners are `sample_control_account.py::plan_account_controls`, `sample_control_boards.py::plan_board_controls`, `sample_control_openview.py::plan_openview_controls`, `sample_control_access.py::plan_access_controls`, `sample_control_sandbox.py::plan_sandbox_controls`, `sample_control_read_reviews.py::plan_read_reviews`, `sample_control_manage.py::plan_manage_controls`, and `sample_control_reads.py::plan_read_controls`. Audit review is planned and executed in `sample_control_actions.py`.

Sample runs seed realistic organization data and check API stability: each control sends the frontend's request shape, receives its expected status, and leaves the required end state. Per-control audit entity, count, action, and attribution assertions are outside this scope; the existing Phase 0 record and relationship audit checks remain. Repeated record purge reviews are allowed while automation finishes. Invitation completion coverage comes from the existing invitation flow's journal. Each phase's live acceptance uses Harbor Small and School Small; School Standard is required in Phase G.

## Rules for every pack

- Put organization-specific facts in the pack's people, catalog, identity, scenario, and content data. Generic `sample_*.py` planners must use those values and helper callbacks; they must not branch on a pack key or hard-code a pack's module or department keys.
- A control uses a real pack-authored object or person, then restores or removes its temporary changes. Do not insert rows directly through SQL, ORM, provider-admin APIs, or fabricated audit evidence.
- Every created name, label, description and note must be natural content a person in that organization would write, grounded in the pack's research and vocabulary. Use pack content callbacks and authored business facts. Seeds, hexadecimal suffixes, generation markers and verification instructions belong only in private run metadata; never append them to organization content.
- Do not add fixed credentials, recovery tokens, provider secrets, or real personal data to a pack. Runtime-generated credentials and mailbox tokens stay in the private run context.
- For every phase that adds actions, the offline pack-neutral test must plan Harbor and School at Small size and prove the planner consumes pack data without checking Harbor/School keys or embedding pack-specific module/department keys.

## Controls composed through Phase B in `plan_controls`

The current composition has 68 actions: one Account action that exercises nine route-level controls, 27 Board actions across 25 operation names, 14 OpenView actions, seven Access actions, seven Sandbox actions, one Audit review, five read-only reviews, five Manage actions, and a final per-user session revocation. Entries below name every operation; repeated operations are called out explicitly.

### Account security

All nine controls use one active, non-admin pack member with a generated, private credential and an application session. Recovery must reach the owned local mailbox. The run creates disposable sessions, restores the member's original password, and signs the primary client back in before finishing. The pack supplies a valid, deliverable address for that member; it does not supply the password or recovery token.

| Control | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `GET /api/auth/session` — read current session | An active non-admin member whose primary client is authenticated. | Use that member's own current session before changing credentials. | Use a pending invite, guest, or administrator as the account target. |
| `POST /api/auth/refresh` — refresh session | The same member's refreshable session. | Refresh the active primary session, then continue as that member. | Depend on a stale or expired cookie with no refreshable identity. |
| `GET /api/auth/sessions` — list own sessions | The member identity and the disposable sessions opened during the run. | List the member's current and newly opened sessions. | Require a session belonging to another pack person. |
| `DELETE /api/auth/sessions/{session_id}` — end one session | A disposable secondary login for the same member, distinct from the primary client. | End only the secondary client's current session. | End the primary session before the remaining account actions can finish. |
| `POST /api/auth/sessions/revoke-others` — end other sessions | A primary session plus disposable secondary sessions for that member. | Preserve the primary session while revoking the member's other sessions. | Select an administrator session or revoke sessions for a different user. |
| `POST /api/auth/password/change` — change password | An active member with a runtime-held current credential. | Change to a private runtime-generated password, then restore the original. | Put a fixed test password in a pack or leave the temporary password active. |
| `POST /api/auth/recovery/request` — request recovery | The member's valid address routed to the owned local mailbox. | Request recovery for the same active member whose password was changed. | Use an external or unroutable address, or request recovery for a different person. |
| `POST /api/auth/recovery/complete` — complete recovery | A recovery message the owned mailbox can return for that member. | Read the new token from the mailbox and restore the original credential. | Hard-code a token, use another member's message, or store the token in pack data. |
| `GET /api/events` — verify authenticated event stream | The active member's authenticated SSE session so session invalidation can be observed. | Open the stream as the primary member and verify the expected resynchronization. | Open an unauthenticated stream or use another person's session. |

The account planner is in `backend/operations/sample_control_account.py::plan_account_controls`; the run sequence and private credential/mailbox handling are in `execute_account_control`.

### Manage Organization and Security

The existing initial Organization PATCH is extended rather than adding another action. Identity facts supply the name, locale, timezone and currency symbol. The runner derives the mark from name initials and maps the supported symbols to ISO currency (`₱` → `PHP`, `£` → `GBP`); an unknown symbol refuses execution. Monday and `09:00–18:00` are the settled workspace defaults, not separately researched pack facts. Both the PATCH response and a persisted GET must match all seven fields; final configuration verification reads them again.

| Action or existing stage | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| Existing `PATCH /api/workspace` — Organization | Authored workspace name, locale, timezone and supported currency symbol; freshly read shared revision. | Derive `HOG`/`PHP` or `WDS`/`GBP` from the corresponding identity facts, submit Monday/default hours, and confirm persisted GET. | Select currency by pack key, invent a USD fallback, reuse a stale revision, or verify only the PATCH echo. |
| `review_workspace_security` — `GET /api/workspace/security` | An authenticated exact administrator and readable policy. | Read the direct policy object with its shared revision, supported timeout/password choice, Optional MFA and empty IP list. | Mix security fields into general WorkspaceResponse or use a non-admin actor. |
| `update_workspace_security` — `PATCH /api/workspace/security` | A safe Optional/empty-IP baseline and a current shared revision. | Select the supported 20-character passphrase tuple and 30-minute timeout (60 when already 30), verify persisted GET, then restore the original safe policy with the fresh revision and verify again. | Save Required MFA or a restrictive CIDR during pack execution, send an unsupported password tuple, or restore with the old revision. |
| `review_mfa_status` — `GET /api/auth/mfa` | The same active non-admin member used by Account controls, with no enrolled factors under Optional policy. | Confirm that actor's `user_id`, signed `aal1`, `required=false` and empty factors. | Read another person's status or treat an enrolled/required factor as a noninteractive sample state. |
| `review_admin_sessions` — `GET /api/auth/admin-sessions` | A current administrator plus authenticated pack members. | Send the UI's standard pagination/search/sort/status/device query, then a member-name remote/Unknown-device filter sorted by person name; validate shared page metadata and real row identities. | Use a raw array, invent location data, filter only the visible page, or fabricate person/session IDs. |
| `revoke_admin_sessions` — `DELETE /api/auth/admin-sessions` | Every primary active member client has an in-memory credential bound to its mapped ID before revocation. | Preserve only the exact current admin session, prove all primary cookies unauthenticated, then log every primary member back in through the actual API and verify `/auth/me` before later phases. | Revoke only one chosen member, preserve other actors in the fake, skip reauthentication, or put credentials in the manifest/journal. |

Global revocation runs immediately before the existing final per-user revocation. Reauthentication preserves all later phase actors; the subsequent per-user action still leaves its excluded, completed-work target revoked. Disposable rejection handles are outside the mapped primary actor roster and are never selected by later phase actions. Writes retain their actual status/request ID and exact actor identity; ambiguous writes stop without replay. These actions add no per-control audit accounting.

The route guard keeps these exact authenticator-dependent routes in `INTERACTIVE_ACCEPTANCE_ROUTES` under the Phase B8 exception:

- `POST /api/auth/mfa/factors` — real authenticator enrollment.
- `POST /api/auth/mfa/factors/{factor_id}/verification` — real authenticator verification.
- `DELETE /api/auth/mfa/factors/{factor_id}` — factor removal in the same provider acceptance journey.

Real-provider interactive acceptance owns those three routes. Their count and reasons are reported separately; sample journals cannot claim executed pack coverage for them. There is no blanket MFA-prefix exemption. MFA status and workspace policy read/update remain required executable routes. Phase G's permanent deferred scope remains files, notifications, Comms, language and licensing activation.

### Boards

Every Board action shares these pack prerequisites:

- `pack.phases.existing_project_board` names a project in `pack.content.data.projects`.
- The authored project and department groups exist. An active member can write the source project Board and read at least one local record in the department. The planner raises that member's existing group to manage on the disposable copy; group assignments come from the pack.
- The source Board has an exportable configuration and at least one valid widget so its disposable copy can be edited, duplicated, reordered, and cleaned up.
- Pack callbacks provide real post text and a coherent revision (`post_text` and `revised_post`), plus event titles, details, locations, and the organization's timezone.

Only the duplicate and imported copies are mutated or purged; the authored source Board remains the anchor. The plan publishes the same temporary post twice and archives the temporary event twice, so those repeated steps are listed as such.

| Operation and occurrence | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `board_duplicate` | An existing authored project Board that the administrator can duplicate. | Select the project from `phases.existing_project_board` and `content.data.projects`. | Invent a fixed Board ID or point at a project absent from the pack. |
| `board_import` | The same source Board must export a valid supported configuration bundle. | Import the configuration exported from the authored project Board. | Use a fabricated bundle, unsupported version, or a Board key outside the pack. |
| `board_share` | Existing project and department groups, including a real manager's group. | Use the pack's group rows and promote only the manager's existing grant on the disposable copy. | Supply an unknown group ID or add a group/person not defined by the pack. |
| `board_patch` | A meaningful authored Board name for the disposable copy. | Derive “follow-up” from the selected project's pack-authored name. | Replace it with an unrelated fixed name or rename the source Board. |
| `post_create` | Pack scenario totals and `post_text` content for the project scope. | Create a natural project update using the pack's own scenario amounts and vocabulary. | Use a blank post or generic “Sample post 1” copy. |
| `post_patch` | `revised_post` must make a coherent edit to the created post. | Revise the same pack-derived title and body while the post is a draft. | Patch an unrelated post or use an ungrounded placeholder sentence. |
| `post_record_link_create` | A pack record that the Board manager may read, plus the temporary post. | Link the post to a generated record in a module the manager can read. | Link an inaccessible or unrelated record just to satisfy the request shape. |
| `post_record_link_delete` | The link created by the preceding action. | Delete that exact temporary post link before Board purge. | Delete a pack-authored link or leave the temporary link active. |
| `post_publish` — twice | One natural temporary post and two distinct deterministic publication identities. | Publish, unpublish, then publish the edited post again before its lifecycle checks. | Publish a second unrelated post or reuse one publication identity. |
| `post_unpublish` | The post's first publication. | Unpublish the just-published post before the later republish. | Unpublish a draft or another pack's post. |
| `post_delete` | The republished temporary post. | Archive the same temporary post after its second publication. | Delete the authored source post or delete before the planned publication. |
| `post_restore` | The temporary post archived by `post_delete`. | Restore that same post and confirm its published state. | Create a replacement post instead of restoring the archived one. |
| `event_create` | A pack event title, details, location, timezone, and valid anchor date. | Create a plausible organization event from `event_titles`, `event_details`, and `event_locations`. | Use a fixed event unrelated to the pack or a timezone not supplied by its identity. |
| `event_patch` | A coherent event-details revision from the pack's `revised_post` callback. | Update details on the temporary event while preserving its title and schedule. | Replace the event details with generic filler or edit a source event. |
| `event_record_link_create` | A readable pack record and the temporary event. | Link the event to the same eligible department record used by the Board workflow. | Link to a record outside the manager's read scope. |
| `event_record_link_delete` | The event link created immediately before it. | Remove that exact temporary link before archive and purge. | Leave the link attached or remove a pack-authored link. |
| `event_archive` — twice | The created event and its current state. | Archive, restore, archive again, then delete the same temporary event. | Treat one archive call as sufficient and skip the second planned transition. |
| `event_restore` | The event after its first archive. | Restore that event before the second archive. | Restore an event that was never archived or a different event. |
| `event_delete` | The temporary event after its second archive. | Delete the archived event after its relationship link has been removed. | Delete an authored event or leave the temporary link/dependencies behind. |
| `widget_patch` | At least one supported widget copied from the source Board, with a valid module and config. | Patch the first widget on the disposable copy, retaining its type, module, and config. | Depend on a widget ID or module ID hard-coded for one pack. |
| `widget_duplicate` | The widget recorded by `widget_patch` on the duplicate. | Duplicate that copied widget and record the returned new ID. | Reuse the source widget ID as if it were the duplicate. |
| `widget_order` | The active widget IDs on the disposable copy. | Reorder the copied Board's current widget list. | Provide IDs from another Board or assume a fixed widget count. |
| `widget_delete` | The duplicate widget created above. | Delete only the disposable copy created by `widget_duplicate`. | Delete the original source widget or a widget not mapped by the run. |
| `purge_duplicate` | The disposable duplicate after its temporary post, event, links, and widgets have been handled. | Archive, preview, and purge the duplicate after its temporary content is cleaned up. | Purge the authored source project Board or bypass the preview. |
| `purge_import` | The separate imported copy with no unhandled temporary dependencies. | Archive, preview, and purge the imported copy created by `board_import`. | Reuse the duplicate's ID or purge a pack-authored Board. |

Source: `backend/operations/sample_control_boards.py::plan_board_controls`, `sample_control_board_content.py`, `sample_control_board_record_links.py`, `sample_control_board_widgets.py`, and `sample_control_board_execution.py`.

### OpenView

The query controls share a pack-derived module manager, a module with a `Name` field and a date or date-time field, valid generated records, and a numeric/integer measure somewhere in the pack. Grouping uses a Select field when available and otherwise the module's Name field. Query definitions and field references are built from pack fields and mapped IDs.

| Operation | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `record_query` | A manager-readable module, valid query fields, and generated records. | Query the selected pack module with its generated module and field IDs. | Hard-code a module or field ID from Harbor or School. |
| `grouped_query` | The same module plus a groupable Select or Name field. | Group by the selected module's pack-derived status/category field. | Choose a nonexistent or unreadable field as the grouping key. |
| `window_query` | A date or date-time field with values generated around the pack anchor date. | Query a date window around the run's anchor date using the chosen date field. | Supply an invalid date field or dates unrelated to the pack's declared span. |
| `aggregate_groups` | A readable module and group dimension. | Count records by the module's own Select field, falling back to Name if needed. | Use a static group ID or a dimension absent from the module. |
| `aggregate_scalar` | A manager-readable module with a Number/Integer measure and a groupable dimension. | Sum a pack-defined amount or count by its Select/Name dimension. | Invent a numeric field or measure not present in the pack schema. |
| `aggregate_date_series` | A date/date-time field and generated values within the pack's span. | Count records across the anchor-relative date window. | Use a non-date field or copy another pack's date range. |
| `aggregate_snapshot_groups` | A groupable field and readable data. | Snapshot a count grouped by a pack-derived category. | Use a dimension whose options do not exist in the pack. |
| `aggregate_snapshot_date_series` | A valid date field and records with pack-derived dates. | Snapshot a date-series count for the selected module. | Hard-code timestamps or use an unrelated module's date field. |
| `view_patch` | An authored saved View source, layout, and manager for its module. | Derive the View name and source from pack fields and `content.data.layouts`. | Create an arbitrary View name or target a module absent from the pack. |
| `dashboard_patch` | An authored department Dashboard and a department-level manager. | Derive the Dashboard name from the selected department in the pack. | Use a module-only manager or hard-code another department. |
| `report_patch` | An authored report source, readable module, and natural report name inputs. | Derive the daily report name from the module and its available group field. | Patch an unrelated or missing report by a fixed identifier. |
| `schedule_patch` | The same authored report and the organization's timezone. | Read, update, and restore that report's schedule using the pack timezone. | Use a timezone string unrelated to the pack or another report's schedule. |
| `record_lifecycle` | A module with a generated record, a Name field, and no published trigger on that module; a manager can write it. The pack provides natural titles for the new record and its changed details. | Choose a trigger-free module and derive both titles from the pack's business vocabulary and record attributes, then restore and purge the record. | Choose a trigger-bearing module or append a seed, machine code, generation marker or verification label to its title. |
| `relationship_delete` | A pack-authored one-to-many or many-to-many edge whose endpoint modules are trigger-free and in one department; the acting member has source write and target read. | Use an existing in-department edge and delete only the temporary relationship and endpoint records created for the control. | Use a cross-department edge, a one-to-one relation, or an actor missing either permission. |

Source: `backend/operations/sample_control_openview_queries.py::plan_openview_query_controls`, `backend/operations/sample_control_openview.py::plan_openview_controls`, and `sample_control_openview_mutations.py`. Record titles come from `SampleDataset.organization.text.record_title`; saved-resource names come from `sample_board_text.py`.

### Access

The Access controls use the first pack department only to describe a temporary empty group. They require one active guest to delete and restore, excluding every actor and target needed by `plan_phases`, and one pending member invitation to resend and revoke. Keep the same guest and invite identities through the paired steps; do not add a user or administrator to make a control possible. Refuse planning if every active guest is reserved for later work.

| Operation | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `create_temporary_group` | At least one authored department and a meaningful coordination purpose within it. | Name the group after that department's actual coordination work using the pack's vocabulary. | Append a seed or machine suffix, hard-code a group ID, or invent a purpose unrelated to the department. |
| `rename_temporary_group` | The group created in the previous step. | Rename that same temporary group using the current revision. | Rename a pack-authored group or skip its current ETag/revision. |
| `delete_temporary_group` | The renamed temporary group, still empty and unassigned. | Delete that temporary group after the rename. | Delete a pack-authored group or attach people/access rows to the temporary group. |
| `delete_user` | One active guest profile from the pack who is neither an actor nor a target in later phases. | Temporarily delete an eligible authored guest while recording its existing access. | Delete a later phase's actor or target, an active member, administrator, pending invite, or unknown ID. |
| `restore_user` | The exact guest deleted above, with its existing role and access state retained. | Restore the same guest and verify its original effective access. | Restore a different person or silently change the guest's group grants. |
| `resend_invitation` | One pending member with a valid pack address routable through the owned invitation flow. | Resend the pack member's pending invitation. | Use an active user, an unaddressable invite, or a hand-created profile. |
| `revoke_invitation` | The same pending member after resend. | Revoke that invite and leave the profile pending but unsent. | Revoke another invite or delete the profile to stand in for invitation revocation. |

Source: `backend/operations/sample_control_access.py::plan_access_controls`.

### Sandbox

Each pack must author a valid Sandbox document and a nonempty vector set that can run against it. `SampleDataset.test_vectors` must preserve the module key, values, event, and trigger IDs from the published design. The run verifies the active test history count is exactly the vector count before clearing it, then recreates every authored vector and checks its per-item result. A count mismatch must stop the clear operation.

| Operation | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `create_checkpoint` | A valid published Sandbox document with a readable current revision and a natural organization purpose for its label and note. | Save the organization's structure review with a note about department handover needs. | Use a fixed revision, seeded label, verification note or label/ID from another pack. |
| `update_checkpoint` | The checkpoint just created and the latest document revision. | Mark the organization's structure as agreed using the current revision. | Update a published checkpoint, append a run marker or reuse a stale revision. |
| `delete_checkpoint` | The same updated temporary checkpoint. | Delete it after confirming its kind and revised label. | Delete an authored published version or skip the preceding readback. |
| `export_import_document` | A complete exportable document whose import is a no-op on authored design data. | Export without versions, import the same bundle, and confirm the document round-trip. | Edit the bundle during import or include version history in the payload. |
| `delete_import_checkpoint` | The single “Before import” checkpoint created by the round-trip. | Remove that generated checkpoint using the current revision. | Delete an unrelated checkpoint or leave the import artifact behind. |
| `clear_test_history` | A nonempty authored vector set and exactly the same active history count at runtime. | Clear only when the list count equals `len(dataset.test_vectors)`. | Clear if the count differs, including when unrelated active tests appeared. |
| `restore_test_history` | Every vector references a module, values, event, and trigger IDs in the pack's published design. | Recreate and detail-read each vector with its exact authored inputs. | Reduce the vector set, substitute IDs, or leave an authored test unrepresented. |

Source: `backend/operations/sample_control_sandbox.py::plan_sandbox_controls`, `sample_control_sandbox_execution.py`, and `backend/operations/sample_blueprint.py::_build_test_vectors`.

### Audit review and export

The two read-only audit actions use the first published module in the supplied pack's catalog and its ordinary API-generated history. The module key/name are existing authored facts; the live module ID comes from the run mapping. Both filter with the UI-supported `entity_type=modules` and `search=<module name>`, then assert each selected entry's owned module ID and exact `target_label`. No new pack field or audit row is required.

| Operation | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `audit_review` — list, options and selected detail | A published catalog module with its mapped ID/name and at least one preceding ordinary API mutation. | Read the filtered module history, confirm the list's module ID/label, derive options from the server, and follow a listed entry ID to detail with the same ID/label. | Select an unrelated latest entry, accept a raw UUID or missing label, invent an audit ID, or hard-code options. |
| `audit_export` — preview and `GET /api/audit-logs/export` | The same natural module history, an administrator, and at most 10,000 filtered rows. | Read the first 10 rows and total under a pinned `created_before` horizon, then download the whole filtered server CSV without `limit`/`offset`; require its count header, parsed row count and preview total to agree, and check owned target labels/content. | Export only the visible page, create a CSV locally, drop the filters/horizon, silently accept truncation, or export all School Standard history without narrowing it. |

Preview and ordinary lists retain the shared pagination shape and `created_at` descending sort. Export checks `text/csv;charset=utf-8`, the `openslate-audit.csv` attachment, `no-store`, `X-Audit-Export-Count`, and the seven columns Date/User/Entity/Action/Target/Before/After through an actual CSV parser. Multiline snapshot cells are preserved; selected preview dates, actors, actions and module-name snapshot content must agree with the downloaded rows, including the server's actor-name trimming and formula-cell escaping. A preview above the cap stops before download, and an unsuccessful or malformed response stops the action. Filtering module history bounds the workload independently of the pack's record count.

Source: `backend/operations/sample_control_actions.py::plan_controls` and `execute_control_action`.

## Additional read-controls lane

`sample_control_read_reviews.py::plan_read_reviews` composes five reviews: `review_view_fields` makes four reads, `review_report_run` makes two, `review_board_tools` makes nine, `review_my_events` makes one, and `review_member_candidates` makes one. Each executor checks the returned objects and selects detail IDs from real list responses. Board reads use only the pack's existing `phases.existing_project_board`; they must not create temporary nodes. `sample_control_reads.py::plan_read_controls` adds `revoke_user_sessions` last, reading the selected member's sessions before and after its bulk DELETE.

| Read operation | Pack must supply | Correct example | Wrong example |
| --- | --- | --- | --- |
| `GET /api/boards/{board_id}/my-access` | The existing project Board and an authenticated administrator. | Read the administrator's own level on the authored Board during the tools review. | Use a temporary Board or assume every member has access. |
| `GET /api/boards/{board_id}/access-preview` | The existing project Board, an administrator, and a pack-authored member whose access is being reviewed. | As administrator, preview that member's access on the authored Board. | Query an arbitrary Board ID or inspect access as a writer without manage access. |
| `GET /api/boards/{board_id}/preview-users` | The same Board anchor and an administrator. | List preview users for the existing project Board as administrator. | Invent candidate users outside the pack roster or use a writer without manage access. |
| `GET /api/boards/{board_id}/activity` | An authored Board with ordinary activity and an administrator. | Read activity for the source Board after its genuine UI-shaped activity exists. | Fabricate activity rows or direct the query to a temporary copy. |
| `GET /api/boards/{board_id}/events/mine` | An authored event with a pack actor as its actual event author. | Query events for the member who created the authored event. | Use an actor who did not author the event or create a temporary event for this read. |
| `GET /api/boards/{board_id}/events/occurrences` | An authored event with valid pack dates/timezone and bounded occurrences, read by an administrator. | Read a bounded window containing the pack event's occurrence. | Use an unbounded date span or a recurrence/date that the pack did not author. |
| `GET /api/boards/{board_id}/post-authors` | The authored Board, its pack-defined active author roster, and an administrator. | Read the source Board's authors during the administrator's tools review. | Return a fixed cross-pack user list. |
| `GET /api/boards/{board_id}/posts/{post_id}/manage-state` | An existing authored published post on the Board and an administrator. | Read management state for the pack's first published source post. | Use a made-up post ID, a draft, or a post on a disposable Board. |
| `GET /api/boards/{board_id}/posts/{post_id}/revisions` | That authored published post with genuine saved revisions and an administrator. | List revisions for the same post changed through normal UI/API work. | Insert revision history directly or point at a post with no revisions. |
| `GET /api/boards/{board_id}/posts/{post_id}/revisions/{revision_id}` | A revision ID returned by the preceding list for the same authored post, read by an administrator. | Read one listed revision by its server ID. | Construct a revision ID or use a revision from another post. |
| `GET /api/views/data-sources` | Pack departments/modules and an active module manager. | List data sources available to the pack's real manager. | Assume every catalog item is readable or hard-code one module key. |
| `GET /api/views/data-sources/{module_id}/fields` | A module source from the pack and its authored fields. | Read fields for a module returned by the data-source list. | Request fields for a module outside the pack catalog. |
| `GET /api/modules/{module_id}/assignable-users` | A pack module and its real user/group assignments; actor is that module's manager. | Read assignable members whose pack grants qualify for the selected module. | Supply fixed users or treat users from another module as assignable. |
| `GET /api/fields` — relationship fields | The pack's actual relationship definitions and mapped field IDs. | Read relationship fields from the same organization catalog used by the run. | Invent a relationship or reuse a field ID from a different pack. |
| `GET /api/reports/{report_id}/runs` — report run list | An authored report with a run created through its normal API and a manager who can read it. | List runs for the pack-derived report after creating a real report run. | Create no report run, fabricate a row, or query a report from another module. |
| `GET /api/reports/{report_id}/runs/{run_id}` — report run detail | A run ID returned by that report's run list. | Read detail for one run of the authored report. | Construct a run ID or pair a run with a different report. |
| `GET /api/access/member-candidates` | An administrator and a pack roster that includes eligible active member candidates. | Let the administrator read candidate members from the authored roster. | Add a fixed candidate not present in the pack or query as an ordinary member. |
| `GET /api/users/{user_id}/sessions` | An administrator and a previously authenticated active member with finished work. | As administrator, list sessions for an eligible member after that member's planned actions are done. | Target the first active account-control member or anyone named by `plan_phases`. |
| `DELETE /api/users/{user_id}/sessions` | An eligible member with active sessions and an administrator actor; this is the final read-control action. | Revoke the remaining sessions for a target excluded from account controls and every `plan_phases` actor and target. | Revoke sessions before dependent work, target an administrator, or include a phase actor or target. |

For the Access session cleanup, exclude the active member selected first by `plan_account_controls` and every actor and target in `plan_phases`; run revocation last so later controls cannot depend on the ended sessions. The target must be an active member with completed work and at least one session. The candidate/session operations and Board tools review use an administrator. OpenView reads use the corresponding module manager; `/events/mine` uses the actual event author selected by the pack's ordinary Board author rotation. Files, notifications, and Comms remain explicitly deferred.
