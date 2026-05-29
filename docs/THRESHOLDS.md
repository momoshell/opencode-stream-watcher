# Threshold tuning guide

Use this guide to tune `stream-watchdog` conservatively. The goal is to catch real silent stalls without creating noisy WARNs for agents that normally think for a while.

This document uses **illustrative starting points**, not broad dogfood claims. The only historical examples we have are earlier silent stalls noted in the design doc, including long quiet turns from `backend-specialist` and `doc-writer`.

## Start with the defaults

If you do not have local usage data yet, start here:

- `warnThresholdMs: 90000`
- `abortThresholdMs: 600000`

That gives agents about 90 seconds of silence before a WARN and about 10 minutes of silence before auto-abort.

If you want to learn your normal patterns without automatic interruption, explicitly opt out with `abortThresholdMs: 0`.

## What to measure

Tune from real watchdog output, not guesswork.

Look at per-agent status data and compare:

- `warns`: how often the watchdog thinks an agent went quiet
- `resumes`: how often work continued after a WARN
- `aborts`: how often an auto-abort actually fired
- `durationP95Ms`: a good "usually slow, but still normal" marker
- `durationMaxMs`: your longest observed turn

## Simple tuning loop

1. Start with defaults.
2. Let the agent run through normal work.
3. Check whether WARNs are frequent for that agent.
4. Compare the agent's `durationP95Ms` and `durationMaxMs`.
5. Raise or lower thresholds one step at a time.

Practical rule of thumb:

- If `warns` stay near zero, your threshold is probably fine.
- If `warns` are common but `resumes` are also common, the threshold is probably too low.
- If real stalls still sit unnoticed for too long, the threshold is probably too high.
- Keep auto-abort on unless you have a concrete reason to opt out with `abortThresholdMs: 0`.

## Choosing a WARN threshold

Treat `durationP95Ms` as your main anchor.

- If `durationP95Ms` is well below the WARN threshold, keep the current setting.
- If `durationP95Ms` is close to the WARN threshold and WARNs are noisy, raise it.
- If `durationMaxMs` is much higher than `durationP95Ms`, do **not** automatically tune to max. A single extreme run may be rare and not worth optimizing around.

Conservative approach:

- Start with 90s.
- If an agent regularly produces harmless WARNs, try 120s.
- If an agent is usually fast and stalls should surface quickly, try 60s.

## Choosing an ABORT threshold

Auto-abort is on by default. Keep `abortThresholdMs` comfortably above `warnThresholdMs` so WARN has time to surface first.

If you want auto-abort fully disabled, explicitly set `abortThresholdMs` to `0`.

When tuning auto-abort:

- set it comfortably above `warnThresholdMs`
- leave enough time to notice the WARN and press **Esc** yourself if needed
- prefer a large gap at first, such as WARN at 90s and ABORT at 180s or the 10-minute default

### Migration note for older configs

If you already set `warnThresholdMs` above `600000`, also set `abortThresholdMs` higher than `warnThresholdMs` or set it to `0`.

Otherwise the watchdog may auto-abort before WARN fires.

## Example profiles

These are **sample starting profiles**, not validated presets.

### High-reasoning reviewer-style agent

For reviewer-style agents that legitimately spend longer on deep analysis, start higher:

```json
{
  "stream-watchdog": {
    "perAgent": {
      "code-reviewer-deep": {
        "warnThresholdMs": 120000,
        "abortThresholdMs": 0,
        "duration": {
          "minToastMs": 45000,
          "slowToastMs": 90000
        }
      }
    }
  }
}
```

Use this profile when WARNs are mostly false positives, the agent's `durationP95Ms` already trends high, and you want to explicitly disable auto-abort for that agent.

### Fast doc-writer style agent

For agents that usually respond quickly, start lower:

```json
{
  "stream-watchdog": {
    "perAgent": {
      "doc-writer": {
        "warnThresholdMs": 60000,
        "abortThresholdMs": 0,
        "duration": {
          "minToastMs": 15000,
          "slowToastMs": 30000
        }
      }
    }
  }
}
```

Use this profile when long silent gaps are unusual, you want earlier visibility, and you want to explicitly disable auto-abort for that agent.

## Copy-paste multi-agent example

```json
{
  "stream-watchdog": {
    "perAgent": {
      "code-reviewer-deep": {
        "warnThresholdMs": 120000,
        "abortThresholdMs": 0,
        "duration": {
          "minToastMs": 45000,
          "slowToastMs": 90000
        }
      },
      "doc-writer": {
        "warnThresholdMs": 60000,
        "abortThresholdMs": 0,
        "duration": {
          "minToastMs": 15000,
          "slowToastMs": 30000
        }
      }
    }
  }
}
```

## How to adjust after a week of normal use

You do **not** need formal benchmarking. Just review whether the numbers match your experience.

- Too many harmless WARNs for one agent: raise `warnThresholdMs` for that agent.
- Very few WARNs, but real stalls still feel late: lower `warnThresholdMs` modestly.
- `durationP95Ms` is stable but `durationMaxMs` has one-off spikes: tune around p95, not the single max.
- Auto-abort feels risky: disable it again with `abortThresholdMs: 0`.

The safest pattern is: **tune WARN first, then either keep the default auto-abort gap or opt out explicitly with `abortThresholdMs: 0`**.
