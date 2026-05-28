import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { getDefaultWatchdogConfig, loadWatchdogConfig } from "../src/config.js";
import { createTrackedSessions, resolveDurationConfig, startTracking } from "../src/state.js";

describe("turn duration model", () => {
  test("defaults duration reporting on and records call start plus prior turn duration", () => {
    const config = getDefaultWatchdogConfig();
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-1", { agent: "coder" }, 10_000, {
      lastTurnMs: 4_200,
    });

    expect(config.duration).toEqual({
      enabled: true,
      minToastMs: 5_000,
      slowToastMs: 30_000,
    });
    expect(tracked.callStart).toBe(10_000);
    expect(tracked.lastActivity).toBe(10_000);
    expect(tracked.lastTurnMs).toBe(4_200);
  });

  test("merges valid global and project duration config by nested key", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: {
            enabled: false,
            minToastMs: 10_000,
            slowToastMs: 60_000,
          },
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: {
            minToastMs: 7_500,
          },
        },
      }));

      const config = await loadWatchdogConfig({ globalConfigPath, projectConfigPath });

      expect(config.duration).toEqual({
        enabled: false,
        minToastMs: 7_500,
        slowToastMs: 60_000,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back invalid global duration values without erasing valid nested keys", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: {
            enabled: false,
            minToastMs: "bad",
            slowToastMs: 45_000,
          },
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({ "stream-watchdog": {} }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => logMessages.push(message),
      });

      expect(config.duration).toEqual({
        enabled: false,
        minToastMs: 5_000,
        slowToastMs: 45_000,
      });
      expect(logMessages).toContain(
        "Invalid stream-watchdog.duration.minToastMs value; expected positive number. Using fallback.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back to defaults when whole duration block is invalid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: 123,
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: ["bad"],
        },
      }));

      const config = await loadWatchdogConfig({ globalConfigPath, projectConfigPath });

      expect(config.duration).toEqual({
        enabled: true,
        minToastMs: 5_000,
        slowToastMs: 30_000,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back whole invalid duration blocks to default thresholds", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const scalarGlobalConfigPath = join(tempDir, "scalar-global.json");
    const validGlobalConfigPath = join(tempDir, "valid-global.json");
    const emptyProjectConfigPath = join(tempDir, "empty-project.json");
    const arrayProjectConfigPath = join(tempDir, "array-project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(scalarGlobalConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: 1,
        },
      }));
      await writeFile(validGlobalConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: {
            enabled: false,
            minToastMs: 10_000,
            slowToastMs: 60_000,
          },
        },
      }));
      await writeFile(emptyProjectConfigPath, JSON.stringify({ "stream-watchdog": {} }));
      await writeFile(arrayProjectConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: [],
        },
      }));

      const scalarConfig = await loadWatchdogConfig({
        globalConfigPath: scalarGlobalConfigPath,
        projectConfigPath: emptyProjectConfigPath,
        logger: (message) => logMessages.push(message),
      });
      const projectFallbackConfig = await loadWatchdogConfig({
        globalConfigPath: validGlobalConfigPath,
        projectConfigPath: arrayProjectConfigPath,
        logger: (message) => logMessages.push(message),
      });

      expect(scalarConfig.duration).toEqual({
        enabled: true,
        minToastMs: 5_000,
        slowToastMs: 30_000,
      });
      expect(projectFallbackConfig.duration).toEqual({
        enabled: true,
        minToastMs: 5_000,
        slowToastMs: 30_000,
      });
      expect(logMessages.filter((message) => (
        message === "Invalid stream-watchdog.duration value; expected object. Using fallback."
      ))).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores invalid per-agent duration overrides while preserving lower-priority thresholds", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          duration: {
            minToastMs: 8_000,
            slowToastMs: 40_000,
          },
          perAgent: {
            coder: {
              duration: {
                minToastMs: 2_000,
                slowToastMs: 20_000,
              },
            },
          },
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          perAgent: {
            coder: {
              duration: {
                minToastMs: "bad",
                enabled: false,
              },
            },
            reviewer: {
              duration: [],
            },
          },
        },
      }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => logMessages.push(message),
      });
      const sessions = createTrackedSessions();
      const coder = startTracking(sessions, "session-1", { agent: "coder" }, 0);
      const reviewer = startTracking(sessions, "session-2", { agent: "reviewer" }, 0);

      expect(resolveDurationConfig(coder, config)).toEqual({
        enabled: true,
        minToastMs: 2_000,
        slowToastMs: 20_000,
      });
      expect(resolveDurationConfig(reviewer, config)).toEqual({
        enabled: true,
        minToastMs: 8_000,
        slowToastMs: 40_000,
      });
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.coder.duration.minToastMs value; expected positive number. Ignoring.",
      );
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.coder.duration.enabled value; key is not supported for per-agent duration overrides. Ignoring.",
      );
      expect(logMessages).toContain(
        "Invalid stream-watchdog.perAgent.reviewer.duration value; expected object. Ignoring.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
