# DESIGN.md

The design rationale for `opencode-stream-watcher`. If you want the *why* and the architectural decisions, this is the document. The README is for users; this is for contributors.

The product story is now broader than stream stalls alone: the plugin is about **silent subagent failures**. In runtime terms today, that umbrella covers two concrete cases already documented elsewhere in the repo: silent stream stalls and quiet no-op turns for a small built-in specialist set. This document keeps the architecture distinction explicit so the broader story does not imply a new runtime mechanism.

That wording matters: both cases belong under **runtime verification**, not prompt design. A prompt can tell a specialist what good behavior looks like, but it cannot detect an open-but-silent stream or independently verify that a finished quiet specialist turn produced meaningful surfaced work. Those are runtime observations.

Just as importantly, they are **not the same runtime path**. Stream stalls use the tracked-session heartbeat and tick-loop state machine described below. Quiet no-op turns stay a separate, narrower verification path layered on top of completed turns and watched-agent rules. Keeping them separate avoids implying that no-op behavior is part of the stall state machine.

## Root cause: silent stream stalls

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

This is **not** a prompt-design failure (no narration loop, no @agent conflict, no context exhaustion). The agent prompts in the user's setup are well-disciplined: every leaf has `task: false`, an execution contract, and no-op verification on the parent. Prompt hardening has nothing left to offer for the stall case.

It's a runtime/transport problem. The fix for the stall mode has to live at the runtime layer.

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

### Client methods used today

| Method | Purpose |
|---|---|
| `client.session.get({ path: { id: sessionID } })` | Re-read session metadata before surfacing status or aborting so tooling works from current SDK state |
| `client.session.abort({ path: { id: sessionID } })` | Programmatic session cancel for default auto-abort and selective abort tooling |

Current releases use the heartbeat events plus best-effort toasts, structured logs, and `client.session.abort()` when silence crosses the configured abort threshold. Separately, current releases also document/runtime-track quiet no-op turns through config and stats surfaces; that is adjacent product scope, not a change to the stream-stall state machine below.

## Architecture: stall detection path

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
        │              │    │              │    │ + abort()    │
        └──────────────┘    └──────────────┘    └──────────────┘
```

> ℹ️ WARN, RESUME, and ABORT state transitions each fire **at most once per stall window**.

State machine per tracked session:

```
tracking ──(idle > warnMs)──► warned ──(activity resumes)──► tracking
   │                            │
   ├──(idle > abortMs && abortEnabled)──► aborted
   │                            │
   │                            ├──(idle > abortMs && abortEnabled)──► aborted
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
- By default, `abortThresholdMs` is `600000` (10 minutes).
- If `abortThresholdMs > 0`, the state machine can transition from either `tracking` or `warned` to `aborted`, depending on whether the abort threshold lands before or after WARN.
- Before tool-driven status or abort work, the plugin may re-read the live session through `client.session.get()` and then call `client.session.abort()` if the abort should proceed.
- Setting `abortThresholdMs` to `0` is the explicit opt-out.

## UX

### Toast shapes

| State | Variant | Title | Duration | Current behavior |
|---|---|---|---|---|
| WARN | warning | `⏸ Stream stalled` | 0 (sticky) | Toast body includes agent, session label, idle seconds, last part kind, and the Esc / Huginn selective-abort hint. |
| RESUME | success | `▶ Stream recovered` | 4000ms | Toast body is `<agent> · <slug-or-sessionID> · resumed after <Xs>`. |
| ABORT | error | `🛑 Aborted stalled stream` | 8000ms | When auto-abort succeeds, the plugin aborts the session and surfaces an error toast plus structured log entry. |
| Selective abort | error | `🛑 Aborted stalled stream` | 8000ms | The same abort path is used when a foreground agent calls `watchdog_abort`. |

### De-duplication rules

- One WARN per stall window. After WARN, re-arm only after >30s of resumed activity, then the next stall can trigger a fresh WARN.
- RESUME fires only if a WARN preceded it in the same session lifetime.
- ABORT state transitions only when `abortThresholdMs > 0`; they can occur from `tracking` or `warned` depending on threshold timing.

### Why Esc, not Ctrl+C

opencode's keybinding system treats `esc` as the interrupt key (`escape:"esc"` in the binary; `interrupts:` keybinding category exists). Ctrl+C is shell-level SIGINT and is not the right hint for a TUI user.

## Reaction paths

| Path | When | Mechanism |
|---|---|---|
| Esc cascade | Single active delegation stalls | User hits Esc — opencode's TUI interrupt key. In observed setups (e.g., Muninn → backend-specialist), this reaches the active subagent and the parent sees `error=Aborted process`, handled per its existing no-op verification protocol. |
| `watchdog_abort` tool | Parallel delegations where only one is stuck | Foreground agent calls `watchdog_abort(sessionID)` and the plugin cancels just that one session. |
| `watchdog_status` tool | Before deciding to kill | Lists tracked sessions with idle times and last-part kind to help judge "real stall" vs "long reasoning." |
| `read_session` (via opencode-handoff plugin) | Forensic | If the user has `opencode-handoff` installed, ask the foreground agent to read the stuck subagent's transcript so far. |
| Wait it out | When unsure | Sticky WARN persists until activity resumes (RESUME confirms) or the default 10-minute auto-abort fires, unless you set `abortThresholdMs: 0`. |
| Restart opencode | Esc didn't propagate | Nuclear, rare. Documented in README, not engineered around. |

In short: for the stall path, the plugin detects, logs, warns, and by default auto-aborts long silent stalls; users can still opt out with `abortThresholdMs: 0`.

## Distribution

npm package, name `opencode-stream-watcher`. Matches the unscoped community convention (`opencode-handoff`, `opencode-helicone-session`, `opencode-agent-memory`). Users add to `opencode.json`:

```json
{ "plugin": ["opencode-stream-watcher"] }
```

opencode auto-resolves from npm at startup and caches in `~/.cache/opencode/node_modules/`.

### Versioning

- `0.1.x` — initial notify-first shape: one tick loop, WARN/RESUME toasts, structured logs, config-driven thresholds, no default auto-abort.
- `0.2.x` — added `watchdog_status` / `watchdog_abort`, successful programmatic aborts, and a default `abortThresholdMs` of `600000` with explicit opt-out via `0`.
- `1.x` — current shape: trusted default auto-abort, stats counters, threshold guidance, and ongoing tuning based on real-world false-positive rates and threshold data.

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

These are future-version questions, not blockers for the current design:

1. **How should programmatic abort surface to the parent session?** Esc cascade behavior is known; `client.session.abort()` works for the plugin, but parent-session UX may still need polishing.
2. **Is the 30s re-arm window the right trade-off?** It prevents WARN spam after brief recoveries, but may still need tuning with real-world usage.
