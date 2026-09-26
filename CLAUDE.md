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

## Impeccable hook

The impeccable design hook runs after each Edit/Write on UI files and again at Stop (configured in `.claude/settings.json`). Treat its findings with the triage rules in `.agents/skills/impeccable/reference/hooks.md`: fix real problems, never add an ignore to skip a fix, and ask before `ignore-file` or `ignore-rule`.
