import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { getDefaultWatchdogConfig, loadWatchdogConfig } from "../src/config.js";

describe("watchdog default abort threshold", () => {
  test("getDefaultWatchdogConfig returns 600000ms abort threshold", () => {
    const config = getDefaultWatchdogConfig();

    expect(config.abortThresholdMs).toBe(600_000);
  });

  test("loadWatchdogConfig with missing config files keeps 600000ms default", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "stream-watchdog-default-config-"));

    try {
      const globalConfigPath = join(tempRoot, "missing-global-opencode.json");
      const projectConfigPath = join(tempRoot, "missing-project-opencode.json");
      const logMessages: string[] = [];
      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => {
          logMessages.push(message);
        },
      });

      expect(config.abortThresholdMs).toBe(600_000);
      expect(logMessages).toHaveLength(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("explicit abortThresholdMs 0 remains opt-out", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "stream-watchdog-explicit-zero-"));

    try {
      const globalConfigPath = join(tempRoot, "global", "opencode.json");
      const projectConfigPath = join(tempRoot, "project", "opencode.json");
      await mkdir(join(tempRoot, "global"), { recursive: true });
      await writeFile(globalConfigPath, JSON.stringify({ "stream-watchdog": { abortThresholdMs: 0 } }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
      });

      expect(config.abortThresholdMs).toBe(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("malformed JSON config warns and falls back to defaults", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "stream-watchdog-malformed-config-"));

    try {
      const globalConfigPath = join(tempRoot, "global-opencode.json");
      const projectConfigPath = join(tempRoot, "missing-project-opencode.json");
      const logMessages: string[] = [];

      await writeFile(globalConfigPath, "{\n");

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => {
          logMessages.push(message);
        },
      });

      expect(config).toEqual(getDefaultWatchdogConfig());
      expect(logMessages.some((message) => message.startsWith(`Failed to load ${globalConfigPath}:`))).toBe(
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("non-missing unreadable path warns and falls back to defaults", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "stream-watchdog-unreadable-config-"));

    try {
      const globalConfigPath = join(tempRoot, "global-config-directory");
      const projectConfigPath = join(tempRoot, "missing-project-opencode.json");
      const logMessages: string[] = [];

      await mkdir(globalConfigPath, { recursive: true });

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => {
          logMessages.push(message);
        },
      });

      expect(config).toEqual(getDefaultWatchdogConfig());
      expect(logMessages.some((message) => message.startsWith(`Failed to load ${globalConfigPath}:`))).toBe(
        true,
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
