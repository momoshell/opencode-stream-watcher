# AGENTS.md

Guidance for AI-assisted contributors (Claude Code, opencode subagents, Aider, etc.) working on this repo. Humans should read this too.

## Project goal

One sentence: detect silent LLM stream stalls in opencode subagents, surface them through TUI toasts and structured logs, and optionally auto-abort.

We're solving a single, narrow problem. Don't expand scope. Don't add a second feature "while you're in there."

## File layout

```
src/
  plugin.ts        # plugin entry: exports `StreamWatchdog: Plugin`
  types.ts         # WatchdogConfig, TrackedSession, StallState
  config.ts        # config loader, defaults, validation
  state.ts         # per-session state machine + tick loop
  notify.ts        # toast + app.log helpers
  tools.ts         # watchdog_status, watchdog_abort (v0.2+)
docs/
  DESIGN.md        # the *why*
  THRESHOLDS.md    # empirical guidance (v1.0+)
  TESTING.md       # how to reproduce a stall locally
scripts/
  stall-fixture.md # synthetic stall recipe for manual testing
.github/
  workflows/       # CI + release
  ISSUE_TEMPLATE/  # bug.yml, feature.yml
  PULL_REQUEST_TEMPLATE.md
```

## Conventions

- **TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`. No `any`. Use `unknown` + narrow.
- **No `console.log`.** Use `client.app.log({ service: "stream-watchdog", level, message })`. This shows up in `~/.local/share/opencode/log/` where users already debug.
- **Esc, not Ctrl+C.** Every user-facing string referring to interrupt key says "Esc". opencode's interrupt binding is Esc by default; Ctrl+C is shell-level SIGINT.
- **One file per concern.** `state.ts` only holds the state machine; `notify.ts` only formats toasts. Don't merge.
- **No surprise side effects at import time.** Plugin setup happens in the exported async function, never at module top level.

## What NOT to add

These are deliberate non-features. Don't propose them unless an issue exists:

- ❌ macOS system notifications (`osascript`) — toasts are sufficient and contextual to opencode.
- ❌ Terminal bell (`\a`) — low signal, annoying, unclear if opencode passes it through.
- ❌ Auto-abort as a v0.1 default — opt-in until v1.0. Users must trust the watchdog first.
- ❌ Custom log files — `client.app.log` writes to opencode's existing log infrastructure.
- ❌ HTTP/WebSocket/external integrations — local plugin only.
- ❌ Persistent state across opencode restarts — in-memory only, ephemeral by design.

## Run / test locally

```bash
# Build
bun install
bun run build

# Symlink into opencode's local plugins dir for live testing
mkdir -p ~/.config/opencode/plugins
ln -sf "$(pwd)/dist/plugin.js" ~/.config/opencode/plugins/stream-watchdog.js

# Restart opencode. Plugin should load on startup.

# Reproduce a stall (see scripts/stall-fixture.md)
# Confirm WARN toast appears after ~90s.
```

For type checking only:

```bash
bun run typecheck
```

## Working from issues

Every PR closes one (and only one) issue. The issue body has:

- **Goal** — one paragraph of context
- **Scope (in)** — explicit file list and behavior
- **Out of scope** — don't sneak these in
- **Acceptance criteria** — checklist the PR must satisfy
- **Depends on** — which issues must merge first

Read the issue end-to-end before writing code. If the acceptance criteria are ambiguous, comment on the issue and ask before guessing.

## When you're stuck

- Read [`docs/DESIGN.md`](docs/DESIGN.md) — the *why*.
- Read the opencode plugin docs: <https://opencode.ai/docs/plugins/>
- Read the existing community plugins for patterns: [`opencode-handoff`](https://github.com/joshuadavidthomas/opencode-handoff), [`opencode-agent-memory`](https://github.com/Tarquinen/opencode-agent-memory).
- Comment on the issue rather than ship a guess.

## PRs

- Reference the issue: `Closes #N` in the PR body.
- Keep the diff small. If it grew unexpectedly, split before merge.
- CI must be green. No skipping `--no-verify`.
- Update CHANGELOG if user-visible behavior changed.

## Commit hygiene

- Imperative present tense: "add WARN toast" not "added WARN toast".
- Body explains *why*, not *what* (the diff shows *what*).
- One logical change per commit. If you ran `git commit --amend` more than twice, your commit is too big.
