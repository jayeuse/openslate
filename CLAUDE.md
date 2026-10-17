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

- **Impeccable is the primary design skill** for design, redesign, critique, audit, and polish. Do not load a second generic design skill for the same task. Use `react-frontend-patterns` for implementation rules and `frontend-design-review` (personal skill) only inside `ui-reviewer`.
- **Design truth** lives in `.impeccable/design.json`, `PRODUCT.md`, and the tokens in `frontend/src/app/globals.css`. Point to these files; never copy token values into other documents.
- **No image generation** exists in this harness. Build code-led: SVG for marks, icons, and illustrations; CSS and canvas for texture and motion. The existing comps in `.impeccable/mocks/` are valid references. If a flow needs a new raster comp or asset, say so and continue code-led; never fake one.
- **Library facts.** This is Next.js 16, React 19, and Tailwind v4 (CSS-first). Before writing framework code from memory, check `node_modules/next/dist/docs/` (per `frontend/AGENTS.md`) or Context7. For a shadcn primitive, check `src/components/ui/` first, then the shadcn MCP.

Correct: `Checked Context7 for the Tailwind v4 @theme syntax, then added the token to globals.css.`
Wrong: `Added a tailwind.config.ts with the new color.` (v4 here has no config file.)

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
