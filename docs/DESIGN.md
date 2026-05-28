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

## Plugin API surface

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

### Client methods currently used

| Method | Purpose |
|---|---|
| `client.tui.showToast({ body: { title, message, variant, duration } })` | TUI toast notifications |
| `client.app.log({ body: { service, level, message } })` | Structured logging into opencode's log stream |

### Client methods relevant for future versions

| Method | Planned use |
|---|---|
| `client.session.abort({ path: { id: sessionID } })` | Programmatic session cancel for selective abort / auto-abort work in v0.2+ / v1.0 |

v0.1 uses the heartbeat events plus best-effort toasts and structured logs. The abort API exists, but the current source does not call it yet.

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
        │ WARN toast   │    │ RESUME toast │    │ ABORT log    │
        │ + app.log    │    │ + app.log    │    │ (state only  │
        │              │    │              │    │  in v0.1)    │
        └──────────────┘    └──────────────┘    └──────────────┘
```

> ℹ️ WARN, RESUME, and ABORT state transitions each fire **at most once per stall window**. In v0.1, WARN and RESUME can surface as toasts and logs; ABORT currently surfaces as a log-stage transition only.

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
3. **Single periodic scan (chosen)** — one `setInterval`, iterate the map every tick. O(n) where n is the number of concurrent active subagent sessions (typically a handful, even in heavily parallel orchestrator setups). Cheap, easy to reason about, easy to test.

### Why we don't poll the log file

The earlier safeguard option ("external log-tailer") would work but has worse ergonomics: it lives outside opencode, can't render toasts, can't call `session.abort`. The plugin path gives us the real TUI surface and the SDK actions in-process.

### Current state machine details

- Tracking starts when `session.status` becomes `busy`.
- Heartbeats come from `message.part.updated`; each event refreshes `lastActivity` and may capture `lastPartKind` (`text`, `reasoning`, or `tool`).
- The plugin keeps one module-level `setInterval` and scans the tracked-session map every `tickMs`.
- WARN triggers once `idleMs >= warnThresholdMs`.
- After WARN, a session only re-arms once there has been more than 30 seconds of resumed activity and the session is no longer past the WARN threshold.
- If `abortThresholdMs > 0`, the state machine can transition from `warned` to `aborted`; in v0.1 that produces an `ABORT` incident log stage but does **not** call `client.session.abort()`.

## UX

### Toast shapes

| State | Variant | Title | Duration | Current behavior |
|---|---|---|---|---|
| WARN | warning | `⏸ Stream stalled` | 0 (sticky) | Toast body includes agent, session label, idle seconds, last part kind, and the Esc / Huginn selective-abort hint. |
| RESUME | success | `▶ Stream recovered` | 4000ms | Toast body is `<agent> · <slug-or-sessionID> · resumed after <Xs>`. |
| ABORT | n/a in v0.1 UI | n/a | n/a | No ABORT toast is implemented today; only the `ABORT` incident log stage exists. |
| Selective abort *(v0.2+)* | tbd | tbd | tbd | Planned once a tool or other UI path actually calls `client.session.abort()`. |

### De-duplication rules

- One WARN per stall window. After WARN, re-arm only after >30s of resumed activity, then the next stall can trigger a fresh WARN.
- RESUME fires only if a WARN preceded it in the same session lifetime.
- ABORT state transitions only when `abortThresholdMs > 0` and the session is already in `warned` state; in v0.1 this is logged but not acted on with a programmatic cancel.

### Why Esc, not Ctrl+C

opencode's keybinding system treats `esc` as the interrupt key (`escape:"esc"` in the binary; `interrupts:` keybinding category exists). Ctrl+C is shell-level SIGINT and is not the right hint for a TUI user.

## Reaction paths

| Path | When | Mechanism |
|---|---|---|
| Esc cascade | Single active delegation stalls | User hits Esc — opencode's TUI interrupt key. In observed setups (e.g., Muninn → backend-specialist), this reaches the active subagent and the parent sees `error=Aborted process`, handled per its existing no-op verification protocol. |
| `watchdog_abort` tool *(v0.2+)* | Parallel delegations where only one is stuck | Planned: foreground agent calls `watchdog_abort(sessionID)` and the plugin cancels just that one session. |
| `watchdog_status` tool *(v0.2+)* | Before deciding to kill | Planned: list tracked sessions with idle times and last-part kind to help judge "real stall" vs "long reasoning." |
| `read_session` (via opencode-handoff plugin) | Forensic | If the user has `opencode-handoff` installed, ask the foreground agent to read the stuck subagent's transcript so far. |
| Wait it out | When unsure | Sticky WARN persists until activity resumes (RESUME confirms). Planned v0.2+ behavior may optionally abort later if configured. |
| Restart opencode | Esc didn't propagate | Nuclear, rare. Documented in README, not engineered around. |

In short: v0.1's real recovery path is operator-driven. The plugin detects, logs, and warns; the user or foreground agent decides what to do next.

## Distribution

npm package, name `opencode-stream-watcher`. Matches the unscoped community convention (`opencode-handoff`, `opencode-helicone-session`, `opencode-agent-memory`). Users add to `opencode.json`:

```json
{ "plugin": ["opencode-stream-watcher"] }
```

opencode auto-resolves from npm at startup and caches in `~/.cache/opencode/node_modules/`.

### Versioning

- `0.1.x` — current implemented shape: one tick loop, WARN/RESUME toasts, structured logs, config-driven thresholds, no programmatic abort call.
- `0.2.x` — planned: tools such as `watchdog_status` / `watchdog_abort`, plus selective-abort UX built on top of the existing tracked-session state.
- `1.0.0` — planned: consider an auto-abort default only after enough dogfood confidence that false positives are rare and understandable.

### Maintenance

The plugin depends on a stable subset of the opencode API: `message.part.updated`, `session.status`, `session.abort`, `tui.showToast`, `app.log`. These are not experimental. Quarterly check for API drift; bump `@opencode-ai/plugin` peer dep accordingly.

If opencode ships a built-in stream-idle timeout, this plugin becomes redundant. That's fine — the goal is solving the problem, not maintaining a moat.

## Log signature

The structured log stream is the durable incident trail. Current stages are:

- `tracking-start` when a session first goes `busy`
- `WARN` when idle time crosses the warn threshold
- `RESUME` when post-WARN activity returns and the session re-arms
- `ABORT` when the state machine crosses the abort threshold

Each log entry includes `sessionID`, `agent`, `idleSeconds`, and `lastPartKind`. This is the signature contributors should preserve when adjusting behavior.

## Open questions

These are future-version questions, not blockers for the current v0.1 design:

1. **How should programmatic abort surface to the parent session?** Esc cascade behavior is known; `client.session.abort()` behavior still needs explicit verification before selective abort ships.
2. **Is the 30s re-arm window the right trade-off?** It prevents WARN spam after brief recoveries, but may still need tuning with real-world usage.
