import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadWatchdogConfig } from "../src/config.js";
import { createTrackedSessions, scanTrackedSessions, startTracking } from "../src/state.js";
import type { WatchdogConfig } from "../src/types.js";

type ThresholdScanConfig = Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs" | "perAgent">;

const GLOBAL_THRESHOLDS: ThresholdScanConfig = {
  warnThresholdMs: 90_000,
  abortThresholdMs: 0,
  perAgent: {},
};

describe("per-agent threshold overrides", () => {
  test("does not warn an exact agent match before its overridden threshold", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-1", { agent: "code-reviewer-deep" }, 0);

    const transitions = scanTrackedSessions(
      sessions,
      {
        ...GLOBAL_THRESHOLDS,
        perAgent: {
          "code-reviewer-deep": { warnThresholdMs: 300_000 },
        },
      },
      95_000,
    );

    expect(transitions).toEqual([]);
    expect(tracked.state).toBe("tracking");
  });

  test("uses global thresholds for unconfigured agents", () => {
    const sessions = createTrackedSessions();
    startTracking(sessions, "session-2", { agent: "coder" }, 0);

    const transitions = scanTrackedSessions(
      sessions,
      {
        ...GLOBAL_THRESHOLDS,
        perAgent: {
          "code-reviewer-deep": { warnThresholdMs: 300_000 },
        },
      },
      95_000,
    );

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.sessionID).toBe("session-2");
    expect(transitions[0]?.from).toBe("tracking");
    expect(transitions[0]?.to).toBe("warned");
    expect(transitions[0]?.idleMs).toBe(95_000);
  });

  test("warns and ignores invalid project per-agent entries without erasing valid fallback config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          perAgent: {
            "code-reviewer-deep": { warnThresholdMs: 300_000 },
          },
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          perAgent: {
            "code-reviewer-deep": { warnThresholdMs: "bad" },
            "array-agent": [],
            "invalid-agent": false,
          },
        },
      }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => logMessages.push(message),
      });

      expect(config.perAgent["code-reviewer-deep"]?.warnThresholdMs).toBe(300_000);
      expect(config.perAgent["invalid-agent"]).toBeUndefined();
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.code-reviewer-deep.warnThresholdMs value; expected positive number. Ignoring.",
      );
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.array-agent value; expected object. Ignoring.",
      );
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.invalid-agent value; expected object. Ignoring.",
      );

      const overriddenSessions = createTrackedSessions();
      const fallbackSessions = createTrackedSessions();
      startTracking(overriddenSessions, "session-3", { agent: "code-reviewer-deep" }, 0);
      startTracking(fallbackSessions, "session-4", { agent: "invalid-agent" }, 0);

      expect(scanTrackedSessions(overriddenSessions, config, 95_000)).toEqual([]);
      expect(scanTrackedSessions(fallbackSessions, config, 95_000)).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects invalid per-agent maps instead of treating arrays as object maps", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          perAgent: {
            "code-reviewer-deep": { warnThresholdMs: 300_000 },
          },
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          perAgent: [],
        },
      }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => logMessages.push(message),
      });

      expect(config.perAgent["code-reviewer-deep"]?.warnThresholdMs).toBe(300_000);
      expect(config.perAgent["0"]).toBeUndefined();
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent value; expected object. Ignoring.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("merges abort thresholds by key and rejects unsupported per-agent keys", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          perAgent: {
            "code-reviewer-deep": {
              warnThresholdMs: 300_000,
              abortThresholdMs: 400_000,
            },
          },
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          perAgent: {
            "code-reviewer-deep": {
              abortThresholdMs: 600_000,
              tickMs: 1_000,
            },
          },
        },
      }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => logMessages.push(message),
      });

      expect(config.perAgent["code-reviewer-deep"]?.warnThresholdMs).toBe(300_000);
      expect(config.perAgent["code-reviewer-deep"]?.abortThresholdMs).toBe(600_000);
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.code-reviewer-deep.tickMs value; key is not supported for per-agent overrides. Ignoring.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
