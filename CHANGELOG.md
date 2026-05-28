# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

- Adds `stream-watchdog.perAgent.<agent-name>` threshold overrides for warn/abort timing; unconfigured or invalid per-agent entries fall back to the global thresholds.
- Adds the `watchdog_abort` plugin tool to manually abort a specific session by ID or, when omitted, the longest-idle tracked session.

## 0.1.0

Initial release.

- Detects quiet subagent stream stalls with WARN toasts and structured logs.
- Shows RESUME toasts when a warned stream starts moving again.
- Supports config loading from opencode config files with validation and defaults.
- Includes maintainer docs for local testing, design rationale, and contribution workflow.
