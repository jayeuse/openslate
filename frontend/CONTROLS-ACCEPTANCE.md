# Frontend controls acceptance

Source: `.todo/CONTROLS.md`. This checklist tracks the approved frontend implementation. All 227 controls have a sample-workspace destination; sample operations never represent backend support. The new sample screens are the sole workspace UI; legacy workspace URLs redirect to their replacement pillars. Authentication and service endpoints remain, but the deleted live business screens are no longer available.

## Verification boundary

- Sample workflows use synthetic tab-local state. No messages, invitations, credentials, files, scheduled jobs, backups, updates, or permission changes are sent to live services.
- Browser feature batches cover representative workflows, responsive layout, negative paths, and isolation. A checklist entry is not a claim of an individually automated test.
- Full production and coverage gates are deferred until push preparation. The obsolete scanner UI coverage step was removed with its source; overall and changed-line coverage gates remain.

## Control map

### Sandbox

Destination: `/sandbox`. Source: [`src/components/sample/sandbox/`](src/components/sample/sandbox/). The Designer reuses the original Sandbox canvas and structure outline, including inline editing, drag placement, resizing, and connection ports. Draft history and versions include canvas geometry; field defaults, select options, and lifecycle controls remain in the sample inspector. Module ordering controls affect the outline independently of free canvas placement.

**Organization Designer**

- 1. Create a department
- 2. Rename a department
- 3. Close a department
- 4. Reopen a department
- 5. Create a module inside a department
- 6. Rename a module
- 7. Reorder modules
- 8. Close a module
- 9. Reopen a module
- 10. Create a field, and select the field type
- 11. Set a field as required or optional
- 12. Set a default value for a field
- 13. Reorder fields
- 14. Set options for a select field
- 15. Close a field
- 16. Reopen a field
- 17. Move an item on the design canvas
- 18. Undo a design action
- 19. Redo a design action
- 20. Save a draft design

**Relationships**

- 21. Create a relationship field
- 22. Select the target module for a relationship
- 23. Set the relationship cardinality (one-to-one, one-to-many, many-to-many)
- 24. Draw a connection between two modules
- 25. Delete a relationship field
- 26. Show a warning if a relationship crosses two departments

**Automation**

- 27. Create a rule
- 28. Select a trigger for a rule (field change, threshold, schedule, new record)
- 29. Select a condition for a rule
- 30. Select an action for a rule (send a notification, send a channel message, create a record, update a field, assign a task)
- 31. Enable a rule
- 32. Disable a rule
- 33. Test a rule inside Simulation
- 34. View the run history for a rule
- 35. Set the priority order for rules
- 36. Delete a rule

**Simulation**

- 37. Load sample records
- 38. Create a test user with a selected role
- 39. Run a test scenario
- 40. View the simulation result for a selected role
- 41. Reset the simulation state
- 42. Exit Simulation without a change to the live system

**Preview**

- 43. Turn on Preview mode
- 44. Select a role to preview
- 45. Refresh Preview after a design change
- 46. Exit Preview mode

**Publish**

- 47. Show a summary of changes before publish
- 48. Confirm the publish action
- 49. Roll back to the previous published version
- 50. View the publish history

**Versions**

- 51. List saved versions
- 52. Compare two versions
- 53. Restore a previous version
- 54. Add a label to a version
- 55. Delete an old version

### Boards

Destination: `/boards`. Source: [`src/components/sample/boards/`](src/components/sample/boards/).

**Organization Board**

- 56. View the organization summary
- 57. Pin a widget
- 58. Reorder widgets
- 59. Set the board visibility for each role

**Department Boards**

- 60. Create a board for a department
- 61. Add a widget to a board
- 62. Remove a widget from a board
- 63. Reorder widgets on a board
- 64. Set the board permission

**Calendars**

- 65. Create an event
- 66. Edit an event
- 67. Delete an event
- 68. Set the event visibility (organization, department, or user)
- 69. Set a recurring event
- 70. Link an event to a record
- 71. Send a reminder for an event

**Announcements**

- 72. Create an announcement
- 73. Edit an announcement
- 74. Delete an announcement
- 75. Pin an announcement
- 76. Set the announcement audience
- 77. Set an expiration date for an announcement

**Embedded Views**

- 78. Add an OpenView item to a board
- 79. Resize an embedded view
- 80. Move an embedded view
- 81. Set the refresh interval for an embedded view
- 82. Remove an embedded view
- 83. Set the permission for an embedded view

### OpenComms

Destination: `/comms`. Source: [`src/components/sample/comms/`](src/components/sample/comms/).

OpenComms uses a full-height channel list, conversation, and members panel, with responsive drawers and bounded pointer/keyboard panel resizing. Channel, category, thread, and message quick actions use keyboard/touch-accessible menus. Detailed configuration uses searchable, staged modals with inherited values, workspace locks, validation, pinned Save/Cancel actions, and unsaved-change protection. The title menu opens preferences, workspace settings, channel management, templates, automation, history, and thread tools.

The versioned configuration sidecar preserves existing conversations, records, threads, and drafts. Effective settings resolve workspace → category → channel; permission exceptions resolve everyone → role → person within each scope. OpenAccess shows the same decisions and links to the Comms editor. Active Eli has protected Comms owner access without changing his OpenAccess role; archive, lock, messaging, and file policies still apply. The default edit window remains 15 minutes. Posting, replies, threads, file actions, and local previews use shared policy evaluation.

Messaging and thread settings control local interaction; recoverable deletion retains originals and edit history. Appearance, send shortcuts, unread/favorite/mute state, and panel preferences persist in the current tab. Platform notification choices remain authoritative, with Comms restrictions and personal choices evaluated together. Membership, notification delivery, scheduling, automation, and retention expose explicit local previews or local records; there are no backend writes, external delivery, automatic scheduled sends, or content purges. Four editable templates apply only selected settings. Configuration history supports before/after inspection and previewed restoration.

Selected file contents remain in tab memory for actual local previews/downloads; only metadata is saved, and reloaded attachments explicitly report that their contents are unavailable. Thread editors preserve composer drafts when switching to detailed settings. Global theme and presence remain shared with Platform.

**Channels**

- 84. Create a channel
- 85. Rename a channel
- 86. Archive a channel
- 87. Organize channels in customizable categories
- 88. Grant channel access to selected roles
- 89. Remove a role's channel access
- 90. Set the post permission for a channel
- 91. Set the view permission for a channel
- 92. Pin a message in a channel
- 93. Search messages in a channel
- 94. Mention a user in a message
- 95. Reference a record in a message
- 96. Allow OpenSlate to post a system message in a channel
- 97. Attach a file to a message
- 98. Attach a record link to a message

**Direct Messages**

- 99. Start a direct message
- 100. Send a message
- 101. Delete an own message
- 102. Edit an own message within a time limit
- 103. Mark a conversation as read
- 104. Mark a conversation as unread
- 105. Block a user

**Threads**

- 106. Start a thread from a message
- 107. Reply inside a thread
- 108. Mark a thread as resolved
- 109. Get a notification for a new thread reply
- 110. View the thread list for a channel

### Access

Destination: `/access`. Source: [`src/components/sample/access/`](src/components/sample/access/).

**Users**

- 111. Invite a user
- 112. Deactivate a user
- 113. Restore a deactivated user
- 114. Trigger a password reset for a user
- 115. Assign a role to a user
- 116. View the activity log for a user
- 117. Delete a user
- 118. Block the deletion of the last active administrator

**Roles**

- 119. Create a role
- 120. Rename a role
- 121. Delete a role
- 122. Block the deletion of a built-in role
- 123. Duplicate a role
- 124. Assign a permission set to a role

**Permissions**

- 125. Grant access to a department
- 126. Revoke access to a department
- 127. Grant access to a module
- 128. Revoke access to a module
- 129. Grant access to an action (create, read, update, close, purge)
- 130. Revoke access to an action
- 131. Grant access to a board
- 132. Grant access to a channel
- 133. Set the visibility for a field
- 134. Preview the effective permission for a role

**Membership**

- 135. Assign a user to a department
- 136. Assign a user to more than one department
- 137. Set the primary department for a user
- 138. Set a job title for a user
- 139. View the organization chart by membership

### OpenView

Destination: `/openview`. Source: [`src/components/sample/openview/`](src/components/sample/openview/).

**Views**

- 140. Select a view type (table, grid, calendar, kanban, timeline, gallery)
- 141. Add a filter
- 142. Remove a filter
- 143. Sort by a column
- 144. Group by a field
- 145. Save the current view
- 146. Set the default view for a module
- 147. Share a view with a user or role

**Dashboards**

- 148. Create a dashboard
- 149. Add a widget to a dashboard
- 150. Remove a widget from a dashboard
- 151. Resize a widget
- 152. Move a widget
- 153. Set the refresh interval for a dashboard
- 154. Set the permission for a dashboard

**Charts**

- 155. Select a chart type (bar, line, pie)
- 156. Select a data source for a chart
- 157. Select an aggregation method (sum, count, average)
- 158. Set a date range for a chart
- 159. Export a chart as an image

**Reports**

- 160. Create a report template
- 161. Select fields for a report
- 162. Set grouping and totals for a report
- 163. Schedule the generation of a report
- 164. Export a report (PDF, CSV, XLSX)
- 165. Share a report with a user or role

### Manage

Destination: `/manage`. Source: [`src/components/sample/manage/`](src/components/sample/manage/).

Manage is an interactive, tab-local administration sample. Security policies,
maintenance, and licensing do not operate live services. Saved settings and
unfinished section drafts survive same-tab navigation/reload when browser storage
is available; the page explains storage failures. Each form saves or discards its
own draft. Section navigation is URL-addressable and works with browser history,
keyboard tabs, and a mobile selector.

Configuration snapshots include Manage organization, security, backup preferences,
demo version/rollback, and license settings only. They exclude drafts, sessions,
activity history, records, people, roles, messages, and files. Restore/reset previews
changes and keeps a recovery snapshot; affected drafts require an explicit discard
decision. Reset changes Manage settings only. Schedule/retention are previews, with
an explicit user-triggered backup simulation and no unattended job or deletion.

Activity combines marked fictional examples with successful local Manage actions.
Search, filters, ordering, and pagination govern the list; CSV export includes all
matching entries, not only the visible page. Invalid date ranges block export.
CSV and configuration JSON can be downloaded locally. Configuration import stays
outside Manage; related Access and Sandbox workflows are linked to their owners.

**Organization**

- 166. Set the organization name
- 167. Set the organization logo
- 168. Set the locale, timezone, and currency defaults
- 169. Set a global business setting

**Security**

- 170. Set the password policy
- 171. Set the session timeout
- 172. View active sessions
- 173. End a session
- End all remote sample sessions, retaining the current session; changes remain
  consistent with Access without invoking real sign-out.
- 174. Configure two-factor authentication
- 175. Configure an IP allow list

**Audit**

- 176. View the audit log
- Search, sort, and page through explicitly synthetic activity, including local
  Manage changes and before/after details.
- 177. Filter the audit log by user
- 178. Filter the audit log by date
- 179. Filter the audit log by entity
- 180. Filter the audit log by action
- 181. Export the audit log
- 182. View the detail for one audit entry

**Backup**

- 183. Trigger a manual backup
- 184. Schedule an automatic backup
- 185. View the backup history
- 186. Restore a backup
- 187. Set the backup retention period
- 188. Download a backup file
- Name, rename, and delete selected configuration snapshots; preview restore
  differences and retention candidates; reset Manage configuration safely.

**Updates**

- 189. Check for an update
- 190. View the update changelog
- 191. Apply an update
- 192. Roll back an update
- 193. View the current version number

**Licensing**

- 194. View the current license tier
- 195. Activate a license key
- 196. View the license usage against the tier limit
- 197. Renew a license
- 198. View the license expiration date
- Compare bundled sample tiers, distinguish Access-derived seat usage from
  illustrative storage, and open sample terms through a button.

Manage acceptance uses `tests/browser/sample/access-manage.spec.ts`,
`manage-security.spec.ts`, and `manage-controls.spec.ts`, plus focused isolated
state tests. Browser checks cover narrow layouts, light/dark themes, keyboard and
dialog focus, field errors, downloads, storage failure, and lack of service writes.

### Platform-Level Controls

Destination: `/platform`. Source: [`src/components/sample/platform/`](src/components/sample/platform/).

**Import and Export**

- 199. Import records from a CSV file
- 200. Import records from an XLSX file
- 201. Map a spreadsheet column to a field during import
- 202. Show an import error for a bad row
- 203. Export records to a CSV file
- 204. Export records to an XLSX file

**Global Search**

- 205. Search across users, departments, modules, records, messages, and files
- 206. Show search results grouped by type
- 207. Open a search result directly

**Notification Center**

- 208. View a list of notifications
- 209. Mark a notification as read
- 210. Mark all notifications as read
- 211. Open the linked record from a notification
- 212. Set a personal notification preference

**Personal Account Settings**

- 213. Change my own password
- 214. Set my own display language
- 215. Set my own theme
- 216. Log out
- 217. View my own active sessions
- 218. End my own session on another device

**Presence Status**

- 219. Set my own status (Available, Busy, Away, Offline)
- 220. View another user's status

**Central File Library**

- 221. Browse files across the organization
- 222. Search a file by name
- 223. View which record a file is attached to

**Cross-Pillar Record Actions**

- 224. Add a record to a Board
- 225. Start a chat thread about a record
- 226. Follow a record for future updates
- 227. Assign a record to a user

### Access Control Center

Destination: `/access`. Source: [`src/components/sample/access/`](src/components/sample/access/).

**P0 — identity and policy safety**

- 228. Navigate seven URL-addressable Access views with invalid-view fallback
- 229. Preserve a valid `user` deep link only while viewing Identities
- 230. Create and manage internal, guest, and service-metadata identities
- 231. Protect the final active Administrator and built-in roles
- 232. Review bulk identity impact before applying a local change
- 233. Revoke an active session without exposing session tokens
- 234. Stage multiple access-rule choices before applying them
- 235. Preview policy impact and resolve same-permission conflicts explicitly
- 236. Simulate allow and deny decisions with an ordered explanation trace
- 237. Block access-review completion while decisions remain unresolved
- 238. Keep Access interactions local with no non-GET BFF or session requests
- 239. Exclude tokens, secrets, credentials, identity data, sessions, and history from policy exports

**P1 — administration and governance**

- 240. Filter, sort, search, and page the unified identity directory
- 241. Resend or revoke an invitation and inspect invitation status
- 242. Disable, restore, revoke, or permanently delete an eligible identity
- 243. Start a role from a template, create a role, and compare selected roles
- 244. Create and edit non-nested manual groups with internal or guest members only
- 245. Review the department organization chart and open group-scoped rules
- 246. Configure safe defaults for new identities
- 247. Validate and preview a versioned policy import before merge or replacement
- 248. Review access activity and preview a policy-only history restore
- 249. Open Manage security from the Access overview

**P2 — usability and inspection**

- 250. Use desktop tabs or the mobile Access-view selector in a viewport-contained page without document overflow
- 251. Review access health, counts, defaults, and recent changes in a compact overview
- 252. Run relevant accessibility scans across Access views and dialogs

## Service boundary

Only authentication remains connected: sign-in, session validation/refresh, logout, and the existing account-setup flow. Workspace branding, permissions, and all business interactions are local; workspace screens make no business API requests or realtime subscriptions. Existing service endpoints remain unused by the workspace UI. Legacy business screens and their exclusive helpers have been removed. New business workflows continue to use tab-local sample data; this cleanup does not connect them to live backend operations.

## Acceptance evidence

See `tests/browser/sample/` for the current feature and entrypoint checks, `tests/browser/sandbox/` for shared canvas interactions, and `tests/browser/shell/` for the new-only navigation and appearance controls. Public and security suites cover sign-in and account setup. The retained real-stack service tests use authenticated BFF requests rather than deleted UI controls; they require the disposable runner and are not claimed as executed by this cleanup.
