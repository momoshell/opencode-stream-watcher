# opencode-stream-watcher

> Detect and recover from silent LLM stream stalls in opencode subagents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## In one minute

`opencode-stream-watcher` catches a narrow but painful failure mode: a subagent is still "running," but the LLM stream has gone silent.

It solves that with:

- a sticky **WARN** toast in the TUI
- a **RESUME** toast if the stream comes back
- structured log entries you can grep later

Default behavior is safe: **warn only, no auto-abort**.

## The problem

You delegate work to an opencode subagent. The TUI shows it's running. Minutes pass. No output. Nothing in the log. The agent isn't crashed — the LLM stream just *stopped emitting tokens*, and opencode has no built-in idle-stream timeout.

The fingerprint in `~/.local/share/opencode/log/`:

```
INFO 10:14:00 service=llm modelID=gpt-5.4 agent=backend-specialist mode=subagent stream
...                                          (22 minutes of silence)
INFO 10:36:36 service=session.prompt cancel
ERROR 10:36:36 error=Aborted process
```

You only know it's stuck because *you* noticed, hit Esc, and reconstructed the timeline after the fact.

## What this plugin does

Subscribes to the opencode message bus, timestamps every streaming chunk per session, and:

- **Warns you** with a sticky TUI toast when a session goes quiet past a threshold (default 90s).
- **Lets you know** when it recovers, via a transient success toast.
- **Optionally auto-aborts** the stalled session (off by default; opt in when you trust it).
- **Logs everything** through opencode's structured log so you can grep incident history.

No system notifications, no terminal bells, no busy-work. Just toast + log.

What a warning looks like in the TUI:

```
┌──────────────────────────────────────┐
│ ⏸  Stream stalled                ⚠  │
│                                      │
│ backend-specialist · ses_1a16…       │
│ Silent for 95s (last: reasoning).    │
│                                      │
│ Esc to interrupt · ask your          │
│ foreground agent to kill it for      │
│ selective abort.                     │
└──────────────────────────────────────┘
```

## Install

**Requires:** opencode v1.2 or later (uses the plugin API).

Add this to your `opencode.json`:

```json
{
  "plugin": ["opencode-stream-watcher"]
}
```

```text
1. Add the plugin entry.
2. Restart opencode.
3. If a subagent stalls, react from the toast.
```

That's it — defaults are safe (warn only, no auto-abort).

### Verify it loaded

On startup the plugin writes a load line to opencode's log. Confirm with:

```bash
grep stream-watchdog ~/.local/share/opencode/log/$(ls -t ~/.local/share/opencode/log/ | head -1)
```

You should see an entry like `service=stream-watchdog level=info ... loaded`.

## Configure

All keys optional; defaults shown:

```json
{
  "plugin": ["opencode-stream-watcher"],
  "stream-watchdog": {
    "warnThresholdMs": 90000,
    "abortThresholdMs": 0,
    "tickMs": 10000,
    "toast": true,
    "log": true
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `warnThresholdMs` | `90000` | Idle milliseconds before a WARN toast fires |
| `abortThresholdMs` | `0` | Idle ms before auto-abort. `0` disables auto-abort (notify-only mode) |
| `tickMs` | `10000` | How often the watchdog checks tracked sessions |
| `toast` | `true` | Show TUI toasts |
| `log` | `true` | Write structured log entries via `client.app.log` |
| `perAgent` | `{}` | Override `warnThresholdMs` and `abortThresholdMs` by exact agent name |

### Per-agent thresholds

```json
{
  "stream-watchdog": {
    "warnThresholdMs": 90000,
    "abortThresholdMs": 0,
    "perAgent": {
      "code-reviewer-deep": {
        "warnThresholdMs": 300000,
        "abortThresholdMs": 0
      },
      "doc-writer": {
        "warnThresholdMs": 60000,
        "abortThresholdMs": 120000
      }
    }
  }
}
```

Use `perAgent` when one agent class naturally runs quieter or should auto-abort sooner. Only `warnThresholdMs` and `abortThresholdMs` can be overridden per agent.

### Auto-abort is opt-in

Set `abortThresholdMs` above `0` only when you trust the watchdog to stop stuck sessions for you.

```json
{
  "stream-watchdog": {
    "warnThresholdMs": 90000,
    "abortThresholdMs": 180000
  }
}
```

Safe default remains notify-only: WARN + RESUME, no auto-abort.

### Tooling

The plugin also exposes two foreground-agent tools:

- `watchdog_status` — inspect tracked sessions and recent watchdog events
- `watchdog_abort` — abort a specific stalled session, or the longest-idle tracked session if you omit an ID

Example `watchdog_status` response:

```text
stream-watchdog: tracking 2 sessions.
Tracked sessions:
- sessionID=ses_1a16c8b9 agent=backend-specialist slug=ses_1a16… idleMs=95000 lastPartKind=reasoning state=warned
- sessionID=ses_7bc2f41e agent=doc-writer slug=ses_7bc2… idleMs=12000 lastPartKind=text state=tracking

Recent events (oldest → newest):
- time=2026-05-28T14:01:35.000Z type=WARN sessionID=ses_1a16c8b9 agent=backend-specialist
- time=2026-05-28T14:03:12.000Z type=RESUME sessionID=ses_f03d91aa agent=code-reviewer
```

Example `watchdog_abort` result:

```json
{
  "aborted": true,
  "sessionID": "ses_1a16c8b9",
  "agent": "backend-specialist",
  "idleMs": 95000
}
```

Turn-duration reporting/config is still pending and intentionally not documented here yet.

## Reaction paths

When a WARN toast appears:

| You want to… | Do this |
|---|---|
| Cancel the stalled session | **Esc** — opencode's interrupt key. In the TUI, this typically reaches the running subagent. |
| Abort only the stuck subagent | Ask your foreground agent to call `watchdog_abort` with the stalled `sessionID`, or let it pick the longest-idle tracked session |
| Wait it out | Sticky toast stays until activity resumes (RESUME toast confirms) or auto-abort fires |
| Restart the whole session | If the subagent stays wedged or repeated stalls suggest a bad state, restart opencode and retry |
| Adjust thresholds | Change the global or `perAgent` config above, then restart opencode |

## How it works

```
opencode bus ──► event hook ──► per-session lastActivity map
                                         │
                              every tickMs (10s)
                                         ▼
                              ┌─ idle > warnThreshold  ──► WARN toast + log
state machine: tracking ─────►│
                              └─ idle > abortThreshold ──► session.abort() + error toast + log
                                         │
                              activity resumes
                                         ▼
                                   RESUME toast + log
```

The watchdog reads `message.part.updated` (fires on every streaming chunk — text, reasoning, or tool delta) and `session.status` events. It emits a **WARN** when activity goes silent past `warnThresholdMs`, **RESUME** if it picks back up, and (optionally) aborts when silence crosses `abortThresholdMs`. Toasts go through `client.tui.showToast()`; the abort goes through `client.session.abort()`.

Details and the *why* behind each decision: [`docs/DESIGN.md`](docs/DESIGN.md).

## Roadmap

- **v0.1 — Notify-only**: WARN + RESUME toasts, structured logs, safe defaults.
- **v0.2 — Selective control** *(current)*: per-agent thresholds, `watchdog_status` + `watchdog_abort`, opt-in auto-abort.
- **Later v0.2.x**: turn-duration reporting/config once the remaining dependency lands.
- **v1.0 — Trusted defaults**: stats counters, empirical threshold guidance, auto-abort default-on.

Why the milestones look this way and what gates a default change → [`docs/DESIGN.md` § Versioning](docs/DESIGN.md#versioning). Live tracking on the [project board](https://github.com/users/momoshell/projects/2/views/1) and [milestones](https://github.com/momoshell/opencode-stream-watcher/milestones).

## Contributing

PRs welcome. Start with [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). Good-first-issues are tagged.

## Not affiliated

opencode is built by Anomaly. This plugin is independent and unaffiliated.

## License

MIT — see [`LICENSE`](LICENSE).
