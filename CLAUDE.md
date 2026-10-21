@AGENTS.md

# Claude Code in OpenSlate

Everything in `AGENTS.md` above applies. This section only covers where Claude Code differs from the Codex setup, and how Claude does design work here.

## Role

Claude is the design and frontend agent for this repository: UI, UX, visual design, brand, design system, and UI copy. Default working scope is `frontend/`. Take backend work only when the task explicitly assigns it, and then follow the backend skills and scoped `AGENTS.md` files as written.

## Codex-to-Claude mapping

- **Skills.** `.claude/skills` is a symlink to `.agents/skills`. They are the same files; the skill paths in `AGENTS.md` stay valid. Edit skills in `.agents/skills` only.
- **Orchestration.** The Codex fleet exists in Claude as user-level subagents in `~/.claude/agents/`, generated from `~/.codex/agents/*.toml` by `~/.agents/scripts/sync-claude-agents.py`. Same names and instructions; models map luna → `sonnet`, sol → `opus`, astra → `fable`, except `implement`, which runs on `opus` (medium effort). Follow the orchestration rules and `.agents/orchestration/PROTOCOL.md` referenced in `AGENTS.md` with these subagents. `agent-task.py doctor` checks the Codex setup only.
- **Subagents.**
  - Fleet (user-level): `explore`, `check_runner`, `browser`, `implement`, `implement_complex`, `review`, `deep_review`, `analyst`, `deep_analyst`, `research`. `AGENTS.md` still says `utility`; use `check_runner` for that role.
  - `ui-reviewer` (project): fresh-context visual and accessibility review of a finished UI change. Prefer it over `review` for visual quality; use `review` for diff and acceptance criteria. Both may run on the same change.
  - `impeccable-finish-reviewer`, `impeccable-documenter`, `impeccable-manual-edit-applier` (project): spawned by the impeccable skill itself. They are generated from `.agents/skills/impeccable/agents/*.toml`; regenerate them after an Impeccable update.
  - Built-in `Explore` and `Plan` are different from the fleet `explore`. For repository tracing, use the fleet `explore`.
- **MCP servers** (`.mcp.json`): `playwright` (browser and screenshots, output in `.playwright-mcp/`), `shadcn` (component registry and source), `context7` (current library docs). There is no PostgreSQL MCP for Claude; use the documented CLI path when database evidence is authorized.

## Design work

- **Design skills: `impeccable` and `ui-ux-pro-max` only.** Impeccable owns design, redesign, critique, audit, polish, and the design-system files; `ui-ux-pro-max` is its reference catalog and never decides or writes design files. Load no other design skill for any design operation, including plugin and personal skills (`design:*`, `frontend-design*`, `artifact-design` outside Artifact pages). `react-frontend-patterns` holds implementation rules, not design direction.
- **Design truth** lives in `.impeccable/design.json`, `PRODUCT.md`, and the tokens in `frontend/src/app/globals.css`. Point to these files; never copy token values into other documents.
- **No image generation** exists in this harness. Build code-led: SVG for marks, icons, and illustrations; CSS and canvas for texture and motion. The existing comps in `.impeccable/mocks/` are valid references. If a flow needs a new raster comp or asset, say so and continue code-led; never fake one.
- **Library facts.** This is Next.js 16, React 19, and Tailwind v4 (CSS-first). Before writing framework code from memory, check `node_modules/next/dist/docs/` (per `frontend/AGENTS.md`) or Context7. For a shadcn primitive, check `src/components/ui/` first, then the shadcn MCP.

Correct: `Checked Context7 for the Tailwind v4 @theme syntax, then added the token to globals.css.`
Wrong: `Added a tailwind.config.ts with the new color.` (v4 here has no config file.)

Correct: `Ran impeccable critique on /boards; pulled two chart-type options from ui-ux-pro-max for the summary widget.`
Wrong: `Ran design:design-critique on /boards, then design:accessibility-review.`

## Visual verification loop

Required for every change that affects rendered UI. Code review alone is not verification.

1. Start the dev server with `npm run dev` in `frontend/`, in the background. Reuse it if it already runs. The port is `FRONTEND_DEV_PORT` (default 3000).
2. Use the playwright MCP to open the changed route and take screenshots at desktop (1440x900) and mobile (390x844).
3. Compare the screenshots with the request and the design system. Fix material problems.
4. Take at most two screenshot rounds. Batch fixes between rounds; do not screenshot after each small edit.
5. For a non-trivial change, spawn `ui-reviewer` with the request, the changed files, and the screenshot paths. Skip this when `impeccable-finish-reviewer` already reviewed the build.
6. Run the frontend static checks once the work unit stabilizes, following the testing rules in `AGENTS.md`.

Correct: `Screenshots at 1440 and 390 show the toolbar wraps on mobile; moved actions into the overflow menu; second round clean; ui-reviewer: ship.`
Wrong: `Updated the toolbar styles; should look good on mobile now.`

## Hands-on testing

Claude owns hands-on testing: using the real app as each role would, on the live development stack. It complements the automated suites and never replaces them; mocked HTTP suites passed while hands-on tests found lost messages and wrong author names.

Run two kinds of passes:

- **Feature pass**, right after each feature or slice that changes user-visible behavior is implemented (including a cutover from mocks to real APIs, and after a defect fix lands). Purpose: find errors, bugs and UX issues early, so they are fixed inside the implementation phase, not after it.
- **Release smoke pass**, once implementation is essentially done and before the pre-push gate. Purpose: smoke out underlying and cross-feature issues before anything is pushed. Cover every role end to end on both a fresh organization (create a new one; never reset development data for this) and an existing sample-pack organization (Harbor, and School when its pack is loaded), plus the flows that span features.

Fresh organizations expose first-run and empty-state defects; sample-pack organizations expose defects that need real volume, many people, groups, records and history. A feature pass uses the sample-pack organization by default, and adds a fresh organization when the feature touches first-run or empty states. Order: smoke pass, then its fixes, then free the machine and run the gate (rule zero forbids running them together).

1. Check preconditions: owned dev stack up (`python3 scripts/dev.py db`), database at head (provision role, `uv run alembic upgrade head`), API `/api/ready` ready. Start nothing beside a heavy test lane or a measurement run (rule zero in `AGENTS.md`).
2. Use one Next dev server per checkout. If another agent needs the port, stop yours; stop it after the pass either way.
3. Sign in with the hands-on accounts below. Use the second account of a two-account test in the playwright MCP browser so its cookies stay separate.
4. Before testing, write down what each account should see and do for the feature under test; then check it against what the app does.
5. A feature pass covers the changed feature for the account levels it affects. A release smoke pass covers, per account level: first-run and empty states, the core flow, permission edges, two-account real-time delivery with measured latency, persistence after reload, desktop 1440x900 and mobile 390x844, console errors, and API request counts on a cold load.
6. Report each defect with steps, expected versus actual, evidence (network, console, screenshot), and severity.
7. Every defect becomes a failing-first automated test in its fix commit. The implementing agent fixes it; Claude retests it by hand.
8. Leave test data in the development database and list what was created.

### Hands-on accounts

Each sample-pack organization keeps one dedicated account per access level (`ho-` means hands-on). Leave the sample people untouched.

| Account | Level | Expected |
|---|---|---|
| `ho-admin` | Organization admin | Manages the organization; cannot read others' DMs or private channels (D43) |
| `ho-manager` | Member, manage on one department | Manages that department's conversations only |
| `ho-writer` | Member, write on some modules | Posts where readable; no admin or manager tools |
| `ho-reader` | Member, read only | Reads; cannot post where posting needs write |
| `ho-noaccess` | Member, no group access | Sees only conversations they belong to |
| `ho-guest` | Guest in one group | Read-capped; no admin or manager actions |

- Create them by inviting in Access → People and completing each invitation through Mailpit (`127.0.0.1:<SUPABASE_MAIL_PORT>`). The owner signs in once to invite `ho-admin`; `ho-admin` invites the rest, so later passes need no owner sign-in.
- Keep the generated passwords only in `~/.config/openslate-handson/accounts.json` (mode 600, outside the repo). If the file is lost, reset through Forgot password and Mailpit.
- Never read `.env` or sample-run credential files (SEC-R3).
- The S34 guarded reset removes these accounts' organization data; recreate them afterwards.

Correct: `Admin in the pane, invited member in playwright MCP: delivery 250 ms, reply live; B7 first send after load dropped with no POST and no "Not sent" (high); sent to the implementer as a failing-first test; retest after the fix.`
Correct: `Release smoke pass on a fresh organization and on Harbor before the gate: admin, member and guest end to end in both; one cross-feature defect (scheduled message ignores a later block) fixed with a failing-first test; then the gate ran on the freed machine.`
Wrong: `HTTP suite is green, so the cutover works.`
Wrong: `Ran the release smoke pass while prepush.py was running.`
Wrong: `Logged in as a sample person using the password from the sample-run file.`
Wrong: `Tested only as admin; the feature works.`

## Advisor (Fable)

The advisor is Fable, set with `/advisor fable` in user settings. Subagents inherit it. Fable has its own weekly limit, separate from the normal limit, so consult it at real decision points; do not ration it to zero, and do not call it on routine turns. Each call reads the full transcript again, so a call late in a long session costs more.

Consult the advisor:

1. Before committing to a design direction, layout approach, or component structure for a new or redesigned surface.
2. After two screenshot rounds that still show a material problem, or when the same error repeats after a fix.
3. Before reporting a large UI change as done, after `ui-reviewer` or `impeccable-finish-reviewer` has returned. Give it the reviewer's findings and your fixes.
4. When a reviewer and your own evidence disagree.

Do not consult it for token or copy tweaks, lint and format fixes, single-component styling changes, or questions that the design files already answer.

If the advisor is unavailable or declines, continue and state it in one line in the final report.

Correct: `Three layout options for /boards: dense table, card grid, split view. Consulting the advisor before choosing.`
Wrong: `Changed the button padding from 8 to 10; consulting the advisor to confirm.`

Correct: `Mobile toolbar still overflows after two rounds. Consulting the advisor with both screenshots and the two attempted fixes.`
Wrong: `Toolbar still overflows. Trying a third and fourth variation.`

## Impeccable hook

The impeccable design hook runs after each Edit/Write on UI files and again at Stop (configured in `.claude/settings.json`). Treat its findings with the triage rules in `.agents/skills/impeccable/reference/hooks.md`: fix real problems, never add an ignore to skip a fix, and ask before `ignore-file` or `ignore-rule`.

## PR review findings

When you fix findings from the Codex reviewer (`chatgpt-codex-connector`) or another reviewer on the active PR, close each thread after the fix is pushed:

1. Push the fix to the PR branch first. Never reply on or resolve a thread for a fix that is only local.
2. Reply on the thread with one brief line: the commit SHA, what changed, and the test that covers it. Use `gh api repos/<owner>/<repo>/pulls/<pr>/comments/<comment_id>/replies`.
3. Resolve the thread with the GraphQL `resolveReviewThread` mutation (find thread ids with `reviewThreads`).
4. If you did not fix a finding, or you fixed it in a different way than it suggests, say so and why in the reply. Leave the thread unresolved if the user must decide.

SEC-R1 still applies: describe only problems in the PR's unmerged changes.

Correct: `Fixed in f7637283: owners can no longer be deleted, disabled, or demoted (409); covered by test_another_administrator_cannot_remove_disable_or_demote_an_owner.` Then resolve the thread.
Wrong: Push the fix and leave the thread open with no reply, or resolve it with no reply.
Wrong: `Thanks for the review! I took a careful look and made several improvements to the code, which should address the concern.`
