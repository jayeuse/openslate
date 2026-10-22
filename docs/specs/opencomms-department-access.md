# OpenComms department access

Status: implemented in `19d140af`, `014a1fd4` and `d8d6be3c` (slices 1 to 3), with the documentation in slice 4. Slice 5, measurement and hands-on acceptance, is pending. Owner decisions on 2026-10-22 (D44 in `docs/plans/opencomms.md`).

## Outcome

OpenComms is available to every member of an organization. A channel is either organization-wide or belongs to one department. Department roles decide who can read, post in, and manage a department channel. No invitations, join requests, or hand-picked channel membership exist. A conversation for a hand-picked set of people is a direct message or a group message.

## Owner decisions

1. "If they have department roles, they can see department specific channels. OpenComms should be available by default, so any org member can see it once they are registered in the org."
2. "There should be no any form of invitation whatsoever. OpenComms is available by default but channels and categories are bound by department roles."
3. Channel types: organization and department only. Channels shared with access groups and private channels are removed (answer to the channel-types question, 2026-10-22).

"Invitation" here means a Comms channel invitation. The organization invitation in Access → People is unchanged: it is how a person joins the organization.

## Starting state (source: code at `d4ed295f`, before D44)

- One access relation decides every channel level: `_conversation_access_statement` in `backend/app/systems/comms/access.py:56-200`. Levels are none, read, post, and manage.
- Channel scopes are `organization`, `department`, `groups`, and `members` (`access.py:137-166`; `frontend/src/components/systems/comms/contract/schemas.ts` `channelSchema`).
- A `department` channel already maps department rows: read → read, write → post, manage → manage (`access.py:87-96,137-154`; `access/policy/readers.py:129-153`).
- OpenComms has no module gate. Any organization member reaches `/comms` (`comms/router.py`; `workspace-navigation.ts:345-356`).
- The channel dialog creates only `groups` or `members` channels (`channel-dialog.tsx:136-148`). It never creates `organization` or `department` channels.
- Five consumers key on `comms_members` rows, not on readers:
  - notification fan-out (`notifications.py:91-98`);
  - mention targets (`messages/admission.py:93-115`);
  - the @channel count in bootstrap (`bootstrap.py:170-178`);
  - member lists, `member_count`, and `member_role` (`conversations/reads.py:78-111,277-305`);
  - the frontend `people` map, which feeds the mention picker, author names, and the member panel (`state/workspace-view.ts:171,194`).

  So in an organization or department channel, only the creator and the default members get notifications, can be mentioned, or appear in the member panel.
- A category has a `department_id` (`conversations/models.py:49`), but channel access does not read it.

## Preserved behavior

- Direct messages and group messages stay membership-based (`kind` `direct` or `group`, scope `members`, `models.py:78-82`).
- D43 stays: an organization admin does not read direct messages or group messages that they are not part of.
- An admin manages every channel in their organization.
- A guest is capped at read.
- D27 capability grants (`CommsCapabilityGrant`) stay. They govern capabilities, not who can read a channel.
- The organization's Realtime topics, search, files, presence, and person visibility keep their reader-based checks.
- D9 stays: a new organization has no channels until an admin or a department manager creates one. `/comms` shows its empty state.

## Exclusions

- No change to organization invitations or Access → People.
- No change to direct-message rules (`dm_rule`, blocks).
- No new access source. Module rows do not grant channel access.

## Acceptance criteria

| ID | Start state | Action | Expected result |
|---|---|---|---|
| A1 | A member has department access none, read, write, or manage on department D | Open a channel in D | 404, read only, post, or manage. Matrix test over all four levels. |
| A2 | A member and a guest in the organization | Open an organization channel | The member posts. The guest reads only. |
| A3 | An admin | List channels and open a DM between two other people | Every channel is listed. The DM is not found (D43). |
| A4 | A member with read access on D, no membership row | Someone posts `@name` for that member in a channel in D | The mention is accepted, and the member gets the mention notification. |
| A5 | Same as A4 | Someone posts in a channel in D | Each reader with notifications on gets the notification. People without access get nothing. |
| A6 | A channel in D | Open its member panel | It lists the people who can read the channel, with their level, and its count matches the list. |
| A7 | A department manager of D | Create a channel | The dialog offers organization (admins only) or a department that the creator manages. The channel is stored with that scope. |
| A8 | A category bound to D | Create or move a channel into it | Only a channel in D is accepted. A category without a department holds organization channels only. |
| A9 | Any member | Search the API and the UI for invitations, join requests, join rules, default members, or group access on channels | None exist. The routes return 404, and the settings keys are refused. |
| A10 | A member loses department access to D | Reload, or wait for the next Realtime event | Channels in D are refused at once (404). Ids stop within the token lifetime (D34). |

## Design (implemented)

1. Channel scopes: `organization` and `department` only. A new CHECK constraint requires that `kind = 'channel'` implies scope `organization` or `department`. Direct and group messages keep scope `members`. Implemented in `014a1fd4` (`ck_comms_conversations_kind_shape` in `conversations/models.py`).
2. Readability follows from the scope. It is the CASE in `_conversation_access_statement` (`access.py`) without the `groups` and `members` channel branches. Implemented in `014a1fd4`.
3. A category bound to a department holds only channels in that department. This is validated on create, on a move to another category, and on duplicate. Implemented in `014a1fd4` (`conversations/service.py`, `conversations/mutations.py`).
4. On channels, `comms_members` becomes a manager roster: it keeps only the creator and the members with the `manager` role. The five consumers listed above use readers through `conversation_reader_statement` and `conversation_reader_ids` (`access.py`). The backend consumers are implemented in `19d140af`, the frontend `people` map in `d8d6be3c`, and the roster rules for member PUT and DELETE in `014a1fd4`.
5. These parts are removed:
   - backend: admissions (routes, `comms_admissions`, `audience.py`), `groups` scope (`comms_conversation_groups`, `PUT …/access`, `category.default_access`), `members`-scope channels, the `join_rule` and `default_member_ids` settings, and `_pending_admission_people` (`person_visibility.py`);
   - frontend: `admissions-api.ts`, `tools-admissions.tsx`, the Request to join state, the group-access field and summary, and `domain/groups.ts`.

   Implemented in `014a1fd4`. The Request to join state left the unavailable-conversation view in `d8d6be3c`.
6. The channel dialog replaces the group-access editor with a scope choice (organization or department) and a department picker. This is a redesigned form surface, so it goes through `impeccable`. Implemented in `d8d6be3c` (`channel-dialog.tsx`, `channel-scope.tsx`).
7. Export (D31) treats every non-channel conversation as private (`private_source` in `jobs/export_service.py`). Implemented in `014a1fd4`.

## Migration (implemented in revision `168d66144b73`)

- Add one new Alembic revision after the current head. Applied revisions stay immutable. `SECURITY.md:164` records `installations-in-use: none`.
- Drop the `comms_admissions` and `comms_conversation_groups` tables.
- Replace the two conversation CHECK constraints.
- Remove `join_rule` and `default_member_ids` from the setting-lock key check.
- Soft-delete the channel member rows that are not managers.
- Existing development data: a `groups` channel with an `everyone` grant becomes `organization`. Other `groups` and `members` channels are archived.
- Sample packs create only `organization` and `department` channels. The sample controls in `backend/operations/sample/controls/comms_*.py` create organization channels. The S34 guarded reset recreates them.

## Deviations from the proposal

These differences between the proposal above and the implemented code are intended.

1. **Downgrade restores the schema only.** Downgrade of `168d66144b73` recreates the dropped tables and the old CHECK constraints. It does not restore dropped access and admission rows, removed settings and lock values, converted or soft-deleted channels, or soft-deleted member rows.
2. **Only a channel where everyone posts becomes organization-wide.** The migration converts a `groups` channel only when its `everyone` grant has level `post`. A channel shared read-only with everyone, and every other `groups` or `members` channel, is soft-deleted. The migration never widens a restricted channel.
3. **The creator's member row stays.** The migration and the member routes keep the creator's row on a channel. When the creator's row has the `manager` role, DELETE sets that role to `member` and keeps the row. The creator still manages the channel through that row.
4. **Retired channels keep their old scope.** The CHECK constraint accepts the old `groups` or `members` scope on a channel only while it is soft-deleted.
5. **A `createChannel` grant creates only department channels** (owner, 2026-10-22). The grant applies only in a department where the holder has a department role of read or higher. Module rows do not count. A grant never creates an organization channel. Category creation keeps the unrestricted grant. See `CapabilityInputs.grant_department` in `comms/capabilities.py`.
6. **A category rebind is refused while it holds other channels.** Changing a category's `department_id` returns 422 `comms_invalid` while a live channel in it has a different department. An organization channel counts as no department. Move those channels out first.
7. **The per-channel manager role stays** (owner, 2026-10-22). A manager must be a current reader of the channel, and a guest cannot be a manager. A removed manager stays a reader by scope and department roles.
8. **Member entries carry a level.** `MemberResponse.level` gives each person's current level (`read`, `post` or `manage`). On a channel, `member_role` is `manager` exactly at level `manage`.

## Security note (SEC-R6)

`access.py` is a listed control ("Comms ordinary content uses current organization/conversation authority"). The change narrows the access sources to scope and department roles. A1 to A3 and A10 are its matrix test. Removing `_pending_admission_people` narrows person visibility; it does not widen it. Notification and mention fan-out widens to all readers, bounded by organization size like `organization_event`.

## Slices

1. Backend access and consumers (A1 to A6, A10): readers for notifications, mentions, @channel, and member lists; the matrix test.
2. Backend removal and migration (A8, A9): admissions, `groups` and `members` channel scopes, the settings keys, and category binding.
3. Frontend (A6 to A9): channel dialog scope and department picker; remove the admissions, join, and group-access UI; update the live fake.
4. Sample packs and documentation: D33, the D36 amendment, D43 wording, and `docs/architecture/08`.
5. Measurement and acceptance: send and notification latency at fan-out to all readers. The earlier S32 numbers measured the old fan-out. Then a hands-on pass with the ho-* accounts.

## Superseded work

These commits were correct for the earlier model. The removal in slice 2 deletes them; they are not reverted one by one:

- `98b4e991`: the member Request to join button.
- `f54a1962`: creating `members`-scope private channels.
- `d4ed295f`: requester visibility for channel managers.

## Addendum: access grants for other departments (D45)

Status: proposed. Owner decision on 2026-10-22, after D44 removed group-shared channels.

### Outcome

A channel still belongs to its organization or to one department. A channel manager can also give access to that channel to Access groups and to individual people outside the department. A grant gives read, or read and post. Grants add to department roles; they never remove access.

Owner words: "if inventory member has granted access to read and send messages in a finance channel, they can do that." Owner choices: grants go to Access groups and to individual people. No channel has more than one owning department.

### Acceptance criteria (proposed)

| ID | Start state | Action | Expected result |
|---|---|---|---|
| G1 | A Finance channel. An Inventory member has no Finance role. | A manager of the channel grants that person "read and post". | The person sees the channel, reads, and posts. Nothing else changes for them. |
| G2 | Same channel. An Access group holds Inventory staff. | A manager grants the group "read". | Every active member of the group reads the channel and cannot post. A person added to the group later gets the same access. |
| G3 | A person has a department role and a grant | Open the channel | The higher level applies. A grant never gives manage. A guest stays capped at read. |
| G4 | A grant exists | A manager removes the grant | The channel returns 404 for that person at once. Realtime ids stop within the token lifetime (D34). |
| G5 | A person with a grant | Someone mentions them, posts @channel, or opens the member list | They are a reader: mentionable, notified by the existing kinds, and listed with their level. |
| G6 | A member who cannot manage the channel | Try to add or remove a grant | The API refuses (403); the UI shows no editor. |
| G8 | A category grant to an Inventory group | Open any channel in that category; move one channel out | Every channel in the category is readable at the granted level; the moved channel loses the category grant. |
| G7 | A channel manager | Search for a person to grant | The search finds active members of the organization by name and shows name and departments only. People outside the organization are never found. |

### Design (proposed)

1. One table of access grants: organization, target (a channel or a category), subject (group or person), level (read or post). One row per subject per target. A category grant applies to every channel in that category, and a channel can add more grants (owner, 2026-10-22, like Discord category sync). Grants only add access; there are no deny grants (owner, 2026-10-22). Direct and group messages cannot have grants.
2. `access.py`: a channel's level is the higher of its scope level and the best grant level for the person from the channel's grants and its category's grants (through their groups or their own row), capped at post; the guest cap and the admin rule stay. Moving a channel to another category changes which category grants apply. D43 is unchanged.
3. Routes: list, add or change, and remove grants on a channel; all need `manageChannel`. A person search for grants needs `manageChannel` on that channel and returns name and departments only.
4. Everything keyed on readers (notifications, mentions, member list, Realtime grants, search, files) follows automatically, because grants feed the same reader relation.
5. Channel settings → Access: the read-only department summary stays, and a list "Also has access" shows each grant with its level and a remove action; "Give access" opens a search over groups and people with a level choice. Layout from ui-ux-pro-max; visual choices from impeccable (owner instruction).
6. Migration: create the table. Channels soft-deleted by `168d66144b73` stay deleted (development data only; no installations in use).

### Security note (SEC-R6)

This widens channel access by explicit grants that only channel managers can create; the reason is the owner decision above. The person search tells a channel manager the names and departments of organization members; it needs `manageChannel` and returns no contact data.
