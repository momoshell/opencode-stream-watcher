# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Add no-op counters to watchdog stats snapshots/status output (`recordNoop`, totals, and per-agent lines).
- Add configurable no-op watch defaults docs, including `noop.enabled`, per-agent `noopWatch`, and the default watched specialist set.
- Successful `watchdog_abort` calls now clear the aborted session from active watchdog tracking/status so it is not auto-aborted again.

## 1.0.0

- **BREAKING CHANGE:** `stream-watchdog.abortThresholdMs` now defaults to `600000` (10 minutes) instead of `0`. To keep notify-only behavior, set `"abortThresholdMs": 0` explicitly.
- Add turn-duration reporting/config docs, including default `stream-watchdog.duration` thresholds and per-agent `minToastMs`/`slowToastMs` overrides.

## 0.2.0

- Adds `stream-watchdog.perAgent.<agent-name>` threshold overrides for warn/abort timing; unconfigured or invalid per-agent entries fall back to the global thresholds.
- Adds the `watchdog_abort` plugin tool to manually abort a specific session by ID or, when omitted, the longest-idle tracked session.

## 0.1.0

Initial release.

- Detects quiet subagent stream stalls with WARN toasts and structured logs.
- Shows RESUME toasts when a warned stream starts moving again.
- Supports config loading from opencode config files with validation and defaults.
- Includes maintainer docs for local testing, design rationale, and contribution workflow.
