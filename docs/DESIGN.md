# DESIGN.md

The design rationale for `opencode-stream-watcher`. If you want the *why* and the architectural decisions, this is the document. The README is for users; this is for contributors.

## Root cause

opencode delegates work to subagents via its `task` tool. Each subagent runs an LLM streaming call (`service=llm ... stream`). The streaming response is delivered as Server-Sent Events.

When the LLM provider stops emitting tokens — network blip, model-side stall during long reasoning, provider edge issue — the SSE connection stays open but no data arrives. opencode (as of v1.15.5) has **no idle-stream timeout**. The session sits forever, or until the user manually hits Esc.

Observed in real sessions:

```
2026-05-25 ses_1a1674b86 backend-specialist (gpt-5.4)
  10:14:00  stream started
  10:36:36  user cancelled  ── 22 minutes silent
```

```
2026-05-23 ses_1aa6c4ab5 doc-writer (gpt-5.4-fast)
  16:03:27  stream started
  16:17:21  user cancelled  ── 14 minutes silent
```

In both, between the stream start and the cancel: no tool calls, no errors, no further LLM events. Just silence.

This is **not** a prompt-design failure (no narration loop, no @agent conflict, no context exhaustion). The agent prompts in the user's setup are well-disciplined: every leaf has `task: false`, an execution contract, no-op verification on the parent. Prompt hardening has nothing left to offer.

It's a runtime/transport problem. The fix has to live at the runtime layer.

## API surface available

We investigated the opencode plugin API (`@opencode-ai/plugin`) and SDK (`@opencode-ai/sdk`). The relevant exposed surfaces:

### Plugin entry

```ts
export const StreamWatchdog: Plugin = async (ctx) => {
  // ctx = { client, project, directory, worktree, serverUrl, $ }
  return { event, config, tool, ... }
}
```

### Bus events we subscribe to

| Event | Payload | Use |
|---|---|---|
| `message.part.updated` | `{ part: Part, delta?: string }` | Heartbeat — fires on every streaming chunk |
| `session.status` | `{ sessionID, status: "busy"\|"idle"\|"retry" }` | Start tracking a session when it goes busy |
| `session.idle` | `{ sessionID }` | Stop tracking — normal completion |
| `session.error` | `{ sessionID, error }` | Stop tracking — already failed |
| `session.deleted` | `{ info.id }` | Clean up |

### Client methods we call

| Method | Purpose |
|---|---|
| `client.tui.showToast({ body: { title, message, variant, duration } })` | TUI toast notifications |
| `client.app.log({ body: { service, level, message } })` | Structured logging into opencode's log stream |
| `client.session.abort({ path: { id: sessionID } })` | Programmatic session cancel |

This is exactly the surface needed: a chunk-level heartbeat we can timestamp, structured logging for incident history, and an abort method for the (eventual) auto-recovery.

## Architecture

```
┌──────────────────┐     ┌──────────────────────┐
│ opencode bus     │ ──► │ event hook (plugin)  │
└──────────────────┘     └──────────┬───────────┘
                                    │
                                    ▼
                         ┌────────────────────────┐
                         │ tracked sessions map   │
                         │   sessionID → {        │
                         │     agent, slug,       │
                         │     lastActivity,      │
                         │     lastPartKind,      │
                         │     state              │
                         │   }                    │
                         └──────────┬─────────────┘
                                    │
                          every tickMs (10s)
                                    ▼
                         ┌────────────────────────┐
                         │ tick loop              │
                         │  for each tracked:     │
                         │   idle = now - last    │
                         │   transition state     │
                         └──────────┬─────────────┘
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
        ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
        │ WARN toast   │    │ RESUME toast │    │ ABORT toast  │
        │ + app.log    │    │ + app.log    │    │ + app.log    │
        │              │    │              │    │ + session    │
        │              │    │              │    │   .abort()   │
        └──────────────┘    └──────────────┘    └──────────────┘
```

State machine per tracked session:

```
tracking ──(idle > warnMs)──► warned ──(activity resumes)──► tracking
   │                            │
   │                            ├──(idle > abortMs && abortEnabled)──► aborted
   │                            │
   ▼                            ▼
session.idle / session.error / session.deleted   ──► (removed)
```

### Why a single tick loop

Alternatives considered:

1. **Per-session timer** — `setTimeout` per session, cleared/reset on each chunk. Rejected: high churn (one timer per chunk per session per active stream), edge cases on cleanup.
2. **Compute idle on every chunk arrival** — purely event-driven. Rejected: doesn't fire when there are no chunks (which is the whole problem).
3. **Single periodic scan (chosen)** — one `setInterval`, iterate the map every tick. O(n) where n is small (typically 1–4 active sessions). Cheap, easy to reason about, easy to test.

### Why we don't poll the log file

The earlier safeguard option ("external log-tailer") would work but has worse ergonomics: it lives outside opencode, can't render toasts, can't call `session.abort`. The plugin path gives us the real TUI surface and the SDK actions in-process.

## UX

### Toast shapes

| State | Variant | Title | Duration | Message hint |
|---|---|---|---|---|
| WARN | warning | `⏸ Stream stalled` | 0 (sticky) | `<agent> · <slug> · silent for Xs (last: <part-kind>). Esc to interrupt · ask Huginn "kill <agent>" for selective abort.` |
| RESUME | success | `▶ Stream recovered` | 4000ms | `<agent> · <slug> · resumed after Xs.` |
| ABORT | error | `🛑 Aborted stalled stream` | 8000ms | `<agent> · <slug> · Xs silent → auto-aborted. Parent will see error.` |

### De-duplication rules

- One WARN per stall window. After WARN, re-arm only after >30s of resumed activity, then the next stall can trigger a fresh WARN.
- RESUME fires only if a WARN preceded it in the same session lifetime.
- ABORT fires only when `abortThresholdMs > 0` AND the session is already in `warned` state.

### Why Esc, not Ctrl+C

opencode's keybinding system treats `esc` as the interrupt key (`escape:"esc"` in the binary; `interrupts:` keybinding category exists). Ctrl+C is shell-level SIGINT and is not the right hint for a TUI user.

## Reaction paths

| Path | When | Mechanism |
|---|---|---|
| Esc cascade | Single active delegation stalls | User hits Esc; opencode interrupts the foreground session and cascades to the active subagent. Parent sees `error=Aborted process`, handles per its existing no-op verification protocol. |
| `watchdog_abort` tool *(v0.2+)* | Parallel delegations where only one is stuck | Foreground agent (Huginn / Muninn) calls `watchdog_abort(sessionID)`; plugin invokes `client.session.abort()` on just that one. |
| `watchdog_status` tool *(v0.2+)* | Before deciding to kill | Lists tracked sessions with idle times and last-part-kind. Helps the user judge "real stall" vs "long reasoning." |
| `read_session` (via opencode-handoff plugin) | Forensic | If the user has `opencode-handoff` installed, ask the foreground agent to read the stuck subagent's transcript so far. |
| Wait it out | When unsure | Sticky WARN persists until activity resumes (RESUME confirms) or abort fires. |
| Restart opencode | Esc didn't propagate | Nuclear, rare. Documented in README, not engineered around. |

## Distribution

npm package, name `opencode-stream-watcher`. Matches the unscoped community convention (`opencode-handoff`, `opencode-helicone-session`, `opencode-agent-memory`). Users add to `opencode.json`:

```json
{ "plugin": ["opencode-stream-watcher"] }
```

opencode auto-resolves from npm at startup and caches in `~/.cache/opencode/node_modules/`.

### Versioning

- `0.1.x` — notify-only, no abort default. Safe to install blind.
- `0.2.x` — adds tools and per-agent config. Still notify-only by default.
- `1.0.0` — flips `abortThresholdMs` default to `600000` after dogfood validation. Breaking-default change documented prominently.

### Maintenance

The plugin depends on a stable subset of the opencode API: `message.part.updated`, `session.status`, `session.abort`, `tui.showToast`, `app.log`. These are not experimental. Quarterly check for API drift; bump `@opencode-ai/plugin` peer dep accordingly.

If opencode ships a built-in stream-idle timeout, this plugin becomes redundant. That's fine — the goal is solving the problem, not maintaining a moat.

## Open questions

These are not blockers; they'll resolve during v0.1 dogfood.

1. **How does the parent session experience a `client.session.abort()` of its delegated child?** We've observed user-initiated Esc cascade producing a clean `error=Aborted process` on both parent and child. Programmatic abort *should* produce the same shape. v0.2 issue #17 explicitly verifies this.
2. **What threshold for "resumed activity" before re-arming WARN?** Current plan: >30s of fresh deltas. May need tuning. Issue #21 (stats counters) will give us data.
3. **Does `message.part.updated` fire for every reasoning token, or only on part-state changes?** Empirical question. If only state changes, we may need to also subscribe to `message.part.delta` (if exposed) for finer-grained heartbeat.
