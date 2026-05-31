import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWatchdogConfig } from "../dist/config.js";

const tempDirs = [];
const DEFAULT_DURATION = {
  enabled: true,
  minToastMs: 5_000,
  slowToastMs: 30_000,
};
const DEFAULT_NOOP = {
  enabled: true,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "stream-watchdog-config-"));
  tempDirs.push(dir);
  return dir;
}

async function writeConfig(filePath, config) {
  await writeFile(filePath, JSON.stringify(config), "utf8");
}

describe("loadWatchdogConfig", () => {
  test("returns defaults when global and project files are missing", async () => {
    const root = await createTempDir();
    const warnings = [];

    const config = await loadWatchdogConfig({
      globalConfigPath: join(root, "global-opencode.json"),
      projectConfigPath: join(root, "project-opencode.json"),
      logger: (message) => {
        warnings.push(message);
      },
    });

    expect(config).toEqual({
      warnThresholdMs: 90_000,
      abortThresholdMs: 600_000,
      tickMs: 10_000,
      toast: true,
      log: true,
      noop: DEFAULT_NOOP,
      duration: DEFAULT_DURATION,
      perAgent: {},
    });
    expect(warnings).toEqual([]);
  });

  test("applies project overrides over global while retaining defaults for missing keys", async () => {
    const root = await createTempDir();
    const globalPath = join(root, "global-opencode.json");
    const projectPath = join(root, "opencode.json");

    await writeConfig(globalPath, {
      "stream-watchdog": {
        warnThresholdMs: 120_000,
        tickMs: 15_000,
        toast: false,
      },
    });

    await writeConfig(projectPath, {
      "stream-watchdog": {
        warnThresholdMs: 30_000,
        abortThresholdMs: 5_000,
      },
    });

    const config = await loadWatchdogConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
    });

    expect(config).toEqual({
      warnThresholdMs: 30_000,
      abortThresholdMs: 5_000,
      tickMs: 15_000,
      toast: false,
      log: true,
      noop: DEFAULT_NOOP,
      duration: DEFAULT_DURATION,
      perAgent: {},
    });
  });

  test("warns and falls back for invalid numeric and boolean values without throwing", async () => {
    const root = await createTempDir();
    const globalPath = join(root, "global-opencode.json");
    const projectPath = join(root, "opencode.json");
    const warnings = [];

    await writeConfig(globalPath, {
      "stream-watchdog": {
        warnThresholdMs: -1,
        abortThresholdMs: -2,
        tickMs: "fast",
        toast: "yes",
        log: "enabled",
      },
    });

    await writeConfig(projectPath, {
      "stream-watchdog": {
        warnThresholdMs: "slow",
      },
    });

    const config = await loadWatchdogConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      logger: (message) => {
        warnings.push(message);
      },
    });

    expect(config).toEqual({
      warnThresholdMs: 90_000,
      abortThresholdMs: 600_000,
      tickMs: 10_000,
      toast: true,
      log: true,
      noop: DEFAULT_NOOP,
      duration: DEFAULT_DURATION,
      perAgent: {},
    });
    expect(warnings.length).toBe(6);
  });

  test("falls back to defaults when project overrides are invalid after valid global values", async () => {
    const root = await createTempDir();
    const globalPath = join(root, "global-opencode.json");
    const projectPath = join(root, "opencode.json");
    const warnings = [];

    await writeConfig(globalPath, {
      "stream-watchdog": {
        warnThresholdMs: 120_000,
        toast: false,
      },
    });

    await writeConfig(projectPath, {
      "stream-watchdog": {
        warnThresholdMs: "invalid",
        toast: "invalid",
      },
    });

    const config = await loadWatchdogConfig({
      globalConfigPath: globalPath,
      projectConfigPath: projectPath,
      logger: (message) => {
        warnings.push(message);
      },
    });

    expect(config).toEqual({
      warnThresholdMs: 90_000,
      abortThresholdMs: 600_000,
      tickMs: 10_000,
      toast: true,
      log: true,
      noop: DEFAULT_NOOP,
      duration: DEFAULT_DURATION,
      perAgent: {},
    });
    expect(warnings.length).toBe(2);
  });

  test("warns for malformed or unreadable config files but does not throw", async () => {
    const root = await createTempDir();
    const malformedPath = join(root, "global-opencode.json");
    const unreadablePath = root;
    const warnings = [];

    await writeFile(malformedPath, "{", "utf8");

    const malformedConfig = await loadWatchdogConfig({
      globalConfigPath: malformedPath,
      projectConfigPath: join(root, "missing-opencode.json"),
      logger: (message) => {
        warnings.push(message);
      },
    });

    expect(malformedConfig).toEqual({
      warnThresholdMs: 90_000,
      abortThresholdMs: 600_000,
      tickMs: 10_000,
      toast: true,
      log: true,
      noop: DEFAULT_NOOP,
      duration: DEFAULT_DURATION,
      perAgent: {},
    });

    const unreadableConfig = await loadWatchdogConfig({
      globalConfigPath: join(root, "missing-global.json"),
      projectConfigPath: unreadablePath,
      logger: (message) => {
        warnings.push(message);
      },
    });

    expect(unreadableConfig).toEqual({
      warnThresholdMs: 90_000,
      abortThresholdMs: 600_000,
      tickMs: 10_000,
      toast: true,
      log: true,
      noop: DEFAULT_NOOP,
      duration: DEFAULT_DURATION,
      perAgent: {},
    });
    expect(warnings.length).toBe(2);
  });
});
