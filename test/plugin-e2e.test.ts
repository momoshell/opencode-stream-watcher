import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd } from "node:process";

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";

import { StreamWatchdog } from "../src/plugin.js";

type PluginInput = Parameters<Plugin>[0];
type PluginClient = PluginInput["client"];
type PluginEvent = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["event"]>>[0];
type StatusTool = {
  execute: (args: { verbose?: boolean }) => Promise<string>;
};
type ToastBody = {
  title?: string;
  message: string;
  variant: "info" | "warning" | "success" | "error";
  duration?: number;
};
type LogBody = {
  service: "stream-watchdog";
  level: "info" | "warn";
  message: string;
  extra?: Record<string, string | number>;
};

describe("StreamWatchdog plugin e2e", () => {
  test("drives WARN → RESUME → ABORT through the public plugin entrypoint", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const clock = restoreDateNow.clock;
      const client = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "stalling-task" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);

      expect(findTrackingStartLog(client.logBodies)).toEqual({
        service: "stream-watchdog",
        level: "info",
        message: "tracking-start",
        extra: {
          sessionID: "session-1",
          agent: "unknown",
          idleSeconds: 0,
          lastPartKind: "unknown",
        },
      });

      clock.now = 32_200;
      await waitUntil(() =>
        findIncidentLog(client.logBodies, "WARN") !== undefined &&
        findToastByTitle(client.toastBodies, "⏸ Stream stalled") !== undefined,
      );

      clock.now = 32_250;
      await plugin.event?.(partUpdatedEvent("session-1", { type: "text" }));
      await waitUntil(() => findToastByTitle(client.toastBodies, "▶ Stream recovered") !== undefined);

      clock.now = 62_351;
      await waitUntil(() => findIncidentLog(client.logBodies, "RESUME") !== undefined);

      clock.now = 63_600;
      await waitUntil(() =>
        client.abortedSessions.includes("session-1") &&
        findIncidentLog(client.logBodies, "ABORT") !== undefined &&
        findToastByTitle(client.toastBodies, "🛑 Aborted stalled stream") !== undefined,
      );

      expect(findIncidentLog(client.logBodies, "WARN")).toEqual({
        service: "stream-watchdog",
        level: "warn",
        message: "WARN",
        extra: {
          sessionID: "session-1",
          agent: "coder",
          idleSeconds: 31,
          lastPartKind: "unknown",
        },
      });
      expect(findToastByTitle(client.toastBodies, "⏸ Stream stalled")).toEqual({
        title: "⏸ Stream stalled",
        message: "Agent: coder\nSession: stalling-task\nIdle: 31s\nLast part: unknown\nEsc to interrupt · ask Huginn \"kill coder\" for selective abort",
        variant: "warning",
        duration: 0,
      });
      expect(findIncidentLog(client.logBodies, "RESUME")).toEqual({
        service: "stream-watchdog",
        level: "info",
        message: "RESUME",
        extra: {
          sessionID: "session-1",
          agent: "coder",
          idleSeconds: 30,
          lastPartKind: "text",
        },
      });
      expect(findToastByTitle(client.toastBodies, "▶ Stream recovered")).toEqual({
        title: "▶ Stream recovered",
        message: "coder · stalling-task · resumed after 0s",
        variant: "success",
        duration: 4000,
      });
      expect(client.abortedSessions).toEqual(["session-1"]);
      expect(findIncidentLog(client.logBodies, "ABORT")).toEqual({
        service: "stream-watchdog",
        level: "warn",
        message: "ABORT",
        extra: {
          sessionID: "session-1",
          agent: "coder",
          idleSeconds: 31,
          lastPartKind: "text",
        },
      });
      expect(findToastByTitle(client.toastBodies, "🛑 Aborted stalled stream")).toEqual({
        title: "🛑 Aborted stalled stream",
        message: "coder · stalling-task · aborted after 31s",
        variant: "error",
        duration: 8000,
      });

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("totals warns=1 resumes=1 aborts=1");
      expect(status).toContain("byAgent agent=coder warns=1 resumes=1 aborts=1");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("removes a tracked session when session.error matches", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const client = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "errored-task" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      const initialStatus = await statusTool.execute({ verbose: true });
      expect(initialStatus).toContain("stream-watchdog: no tracked sessions.");

      await plugin.event?.(busyEvent("session-err-1"));
      await waitForMetadata(client);

      const trackedStatus = await statusTool.execute({ verbose: true });
      expect(trackedStatus).toContain("stream-watchdog: tracking 1 session.");
      expect(trackedStatus).toContain("sessionID=session-err-1");

      await plugin.event?.(sessionErrorEvent("session-err-1"));

      const clearedStatus = await statusTool.execute({ verbose: true });
      expect(clearedStatus).toContain("stream-watchdog: no tracked sessions.");
      expect(clearedStatus).not.toContain("sessionID=session-err-1");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores unknown session.error without changing empty status", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const client = createPluginClient();
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      const statusBefore = await statusTool.execute({ verbose: true });
      expect(statusBefore).toContain("stream-watchdog: no tracked sessions.");

      await plugin.event?.(sessionErrorEvent("missing-session"));

      const statusAfter = await statusTool.execute({ verbose: true });
      expect(statusAfter).toBe(statusBefore);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("suppresses tracking-start log when config log is false", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir, { log: false });
      const client = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "quiet-logs" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-no-log"));
      await waitForMetadata(client);

      expect(findTrackingStartLog(client.logBodies)).toBeUndefined();

      const trackedStatus = await statusTool.execute({ verbose: true });
      expect(trackedStatus).toContain("stream-watchdog: tracking 1 session.");
      expect(trackedStatus).toContain("sessionID=session-no-log");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("records exactly one NOOP after non-edit parts on an idle turn", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-noop-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const client = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "noop-task" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-noop-default"));
      await waitForMetadata(client);
      await plugin.event?.(partUpdatedEvent("session-noop-default", {
        type: "reasoning",
      }));
      await plugin.event?.(partUpdatedEvent("session-noop-default", {
        type: "tool",
        tool: "shell",
        state: { status: "completed" },
      }));
      await plugin.event?.(sessionIdleEvent("session-noop-default"));

      expect(client.logBodies.filter((entry) => entry.message === "NOOP")).toHaveLength(1);

      expect(findIncidentLog(client.logBodies, "NOOP")).toEqual({
        service: "stream-watchdog",
        level: "info",
        message: "NOOP",
        extra: {
          sessionID: "session-noop-default",
          agent: "coder",
          idleSeconds: 0,
          lastPartKind: "tool",
        },
      });
      expect(findToastByTitle(client.toastBodies, "ℹ No-op turn detected")).toEqual({
        title: "ℹ No-op turn detected",
        message: "Agent: coder\nSession: noop-task\nLast part: tool\nNo-op may be a legitimate blocker.\nInspect the session transcript or run watchdog_status for details.",
        variant: "info",
        duration: 4000,
      });

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("stream-watchdog: no tracked sessions.");
      expect(status).toContain("totals warns=0 resumes=0 aborts=0 noops=1");
      expect(status).toContain("byAgent agent=coder warns=0 resumes=0 aborts=0 noops=1");
      expect(status).toContain("type=NOOP sessionID=session-noop-default agent=coder");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("records NOOP stats when log and toast notifications are disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-noop-quiet-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir, { log: false, toast: false });
      const client = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "noop-quiet" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-noop-quiet"));
      await waitForMetadata(client);
      await plugin.event?.(sessionIdleEvent("session-noop-quiet"));

      expect(findIncidentLog(client.logBodies, "NOOP")).toBeUndefined();
      expect(findToastByTitle(client.toastBodies, "ℹ No-op turn detected")).toBeUndefined();

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("stream-watchdog: no tracked sessions.");
      expect(status).toContain("totals warns=0 resumes=0 aborts=0 noops=1");
      expect(status).toContain("byAgent agent=coder warns=0 resumes=0 aborts=0 noops=1");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("counts duplicate idle NOOP events once while notifications are pending", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-noop-duplicate-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const client = createPluginClient({
        logDelayMs: 25,
        sessionMetadata: { agent: "coder", slug: "noop-duplicate" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-noop-duplicate"));
      await waitForMetadata(client);
      await Promise.all([
        plugin.event?.(sessionIdleEvent("session-noop-duplicate")),
        plugin.event?.(sessionIdleEvent("session-noop-duplicate")),
      ]);

      expect(client.logBodies.filter((entry) => entry.message === "NOOP")).toHaveLength(1);
      expect(client.toastBodies.filter((body) => body.title === "ℹ No-op turn detected")).toHaveLength(1);

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("stream-watchdog: no tracked sessions.");
      expect(status).toContain("totals warns=0 resumes=0 aborts=0 noops=1");
      expect(status).toContain("byAgent agent=coder warns=0 resumes=0 aborts=0 noops=1");
      expect(status).toContain("type=NOOP sessionID=session-noop-duplicate agent=coder");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("suppresses NOOP and clears tracking when turn includes a completed edit tool part", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-noop-mutated-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const client = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "noop-mutated" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-noop-mutated"));
      await waitForMetadata(client);
      await plugin.event?.(partUpdatedEvent("session-noop-mutated", {
        type: "tool",
        tool: "apply_patch",
        state: { status: "completed" },
      }));
      await plugin.event?.(sessionIdleEvent("session-noop-mutated"));

      expect(findIncidentLog(client.logBodies, "NOOP")).toBeUndefined();
      expect(findToastByTitle(client.toastBodies, "ℹ No-op turn detected")).toBeUndefined();

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("stream-watchdog: no tracked sessions.");
      expect(status).toContain("totals warns=0 resumes=0 aborts=0 noops=0");
      expect(status).toContain("byAgent agent=coder warns=0 resumes=0 aborts=0 noops=0");
      expect(status).not.toContain("type=NOOP");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("suppresses NOOP for unwatched and disabled agents", async () => {
    const cases: readonly {
      name: string;
      agent: string;
      config?: WatchdogConfigFixture;
    }[] = [
      {
        name: "unwatched-agent",
        agent: "code-reviewer",
      },
      {
        name: "unwatched-explicit-enabled",
        agent: "code-reviewer",
        config: { perAgent: { "code-reviewer": { noopWatch: true } } },
      },
      {
        name: "global-disabled",
        agent: "coder",
        config: { noop: { enabled: false } },
      },
      {
        name: "per-agent-disabled",
        agent: "coder",
        config: { perAgent: { coder: { noopWatch: false } } },
      },
    ];

    for (const testCase of cases) {
      const tempDir = await mkdtemp(join(tmpdir(), `stream-watchdog-e2e-noop-${testCase.name}-`));
      const restoreDateNow = mockDateNow(1_000);

      try {
        await writeWatchdogConfig(tempDir, testCase.config);
        const client = createPluginClient({
          sessionMetadata: { agent: testCase.agent, slug: testCase.name },
        });
        const plugin = await StreamWatchdog({
          client: client.client,
          directory: tempDir,
          project: tempDir,
          worktree: tempDir,
        } satisfies PluginInput);
        const statusTool = plugin.tool?.watchdog_status as StatusTool;

        await plugin.event?.(busyEvent(`session-${testCase.name}`));
        await waitForMetadata(client);
        await plugin.event?.(sessionIdleEvent(`session-${testCase.name}`));

        expect(findIncidentLog(client.logBodies, "NOOP")).toBeUndefined();
        expect(findToastByTitle(client.toastBodies, "ℹ No-op turn detected")).toBeUndefined();

        const status = await statusTool.execute({ verbose: true });
        expect(status).toContain("stream-watchdog: no tracked sessions.");
        expect(status).toContain("totals warns=0 resumes=0 aborts=0 noops=0");
        expect(status).toContain(`byAgent agent=${testCase.agent} warns=0 resumes=0 aborts=0 noops=0`);
        expect(status).not.toContain("type=NOOP");
      } finally {
        restoreDateNow();
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("resolves config root fallback order via public plugin behavior", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-roots-"));
    const worktreeDir = join(rootDir, "worktree");
    const projectDir = join(rootDir, "project");
    const initializerDir = join(rootDir, "initializer");
    const fallbackCwdDir = join(rootDir, "cwd");
    const restoreDateNow = mockDateNow(1_000);
    const originalCwd = cwd();

    try {
      await mkdir(worktreeDir, { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await mkdir(initializerDir, { recursive: true });
      await mkdir(fallbackCwdDir, { recursive: true });

      await writeWatchdogConfig(worktreeDir, { warnThresholdMs: 31_100, abortThresholdMs: 90_000 });
      await writeWatchdogConfig(projectDir, { warnThresholdMs: 41_100, abortThresholdMs: 90_000 });
      await writeWatchdogConfig(initializerDir, { warnThresholdMs: 51_100, abortThresholdMs: 90_000 });
      await writeWatchdogConfig(fallbackCwdDir, { warnThresholdMs: 61_100, abortThresholdMs: 90_000 });

      chdir(fallbackCwdDir);

      const worktreeClient = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "root-worktree" },
      });
      const worktreePlugin = await StreamWatchdog({
        client: worktreeClient.client,
        directory: initializerDir,
        project: { path: projectDir },
        worktree: worktreeDir,
      } satisfies PluginInput);

      restoreDateNow.clock.now = 1_000;
      await worktreePlugin.event?.(busyEvent("session-root-worktree"));
      await waitForMetadata(worktreeClient);

      restoreDateNow.clock.now = 32_200;
      await waitUntil(() => findIncidentLog(worktreeClient.logBodies, "WARN") !== undefined);
      expect(findIncidentLog(worktreeClient.logBodies, "WARN")?.extra?.idleSeconds).toBe(31);

      const projectClient = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "root-project" },
      });
      const projectPlugin = await StreamWatchdog({
        client: projectClient.client,
        directory: initializerDir,
        project: { root: projectDir },
      } satisfies PluginInput);

      restoreDateNow.clock.now = 101_000;
      await projectPlugin.event?.(busyEvent("session-root-project"));
      await waitForMetadata(projectClient);

      restoreDateNow.clock.now = 142_200;
      await waitUntil(() => findIncidentLog(projectClient.logBodies, "WARN") !== undefined);
      expect(findIncidentLog(projectClient.logBodies, "WARN")?.extra?.idleSeconds).toBe(41);

      const directoryClient = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "root-directory" },
      });
      const directoryPlugin = await StreamWatchdog({
        client: directoryClient.client,
        directory: initializerDir,
        project: {},
      } satisfies PluginInput);

      restoreDateNow.clock.now = 201_000;
      await directoryPlugin.event?.(busyEvent("session-root-directory"));
      await waitForMetadata(directoryClient);

      restoreDateNow.clock.now = 252_200;
      await waitUntil(() => findIncidentLog(directoryClient.logBodies, "WARN") !== undefined);
      expect(findIncidentLog(directoryClient.logBodies, "WARN")?.extra?.idleSeconds).toBe(51);

      const cwdClient = createPluginClient({
        sessionMetadata: { agent: "coder", slug: "root-cwd" },
      });
      const cwdPlugin = await StreamWatchdog({
        client: cwdClient.client,
        project: {},
      } satisfies PluginInput);

      restoreDateNow.clock.now = 301_000;
      await cwdPlugin.event?.(busyEvent("session-root-cwd"));
      await waitForMetadata(cwdClient);

      restoreDateNow.clock.now = 362_200;
      await waitUntil(() => findIncidentLog(cwdClient.logBodies, "WARN") !== undefined);
      expect(findIncidentLog(cwdClient.logBodies, "WARN")?.extra?.idleSeconds).toBe(61);
    } finally {
      chdir(originalCwd);
      restoreDateNow();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("keeps setup and event handling alive when log/session/toast clients throw", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-failures-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir, { warnThresholdMs: 31_100, abortThresholdMs: 90_000 });
      const client = createPluginClient({
        throwOnLog: true,
        throwOnSessionGet: true,
        throwOnToast: true,
      });

      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-best-effort"));
      await waitForMetadata(client);

      const trackedStatus = await statusTool.execute({ verbose: true });
      expect(trackedStatus).toContain("sessionID=session-best-effort");

      restoreDateNow.clock.now = 32_200;
      await sleep(30);

      const statusAfterTick = await statusTool.execute({ verbose: true });
      expect(statusAfterTick).toContain("sessionID=session-best-effort");
      expect(statusAfterTick).toContain("totals warns=1 resumes=0 aborts=0");
      expect(client.getSessionCalls).toBeGreaterThanOrEqual(1);
      expect(client.logBodies).toHaveLength(0);
      expect(client.toastBodies).toHaveLength(0);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps unknown and untracked events harmless", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-e2e-events-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeWatchdogConfig(tempDir);
      const client = createPluginClient();
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      const emptyStatus = await statusTool.execute({ verbose: true });

      await plugin.event?.({
        event: {
          type: "unknown.event.type",
          properties: {
            sessionID: "unknown-session",
          },
        },
      } as PluginEvent);
      await plugin.event?.(partUpdatedEvent("untracked-session", { type: "text" }));

      const statusAfterUnknowns = await statusTool.execute({ verbose: true });
      expect(statusAfterUnknowns).toBe(emptyStatus);
      expect(client.abortedSessions).toHaveLength(0);
      expect(findTrackingStartLog(client.logBodies)).toBeUndefined();
      expect(findIncidentLog(client.logBodies, "WARN")).toBeUndefined();
      expect(client.toastBodies).toHaveLength(0);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

type WatchdogConfigFixture = {
  log?: boolean;
  toast?: boolean;
  warnThresholdMs?: number;
  abortThresholdMs?: number;
  tickMs?: number;
  noop?: { enabled: boolean };
  perAgent?: Record<string, { noopWatch?: boolean }>;
};

async function writeWatchdogConfig(
  tempDir: string,
  options: WatchdogConfigFixture = {},
): Promise<void> {
  const {
    log = true,
    toast = true,
    warnThresholdMs = 31_100,
    abortThresholdMs = 31_300,
    tickMs = 5,
  } = options;

  const streamWatchdogConfig: Record<string, unknown> = {
    warnThresholdMs,
    abortThresholdMs,
    tickMs,
    log,
    toast,
    duration: {
      enabled: false,
      minToastMs: 5_000,
      slowToastMs: 30_000,
    },
  };

  if (options.noop !== undefined) {
    streamWatchdogConfig.noop = options.noop;
  }

  if (options.perAgent !== undefined) {
    streamWatchdogConfig.perAgent = options.perAgent;
  }

  await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
    "stream-watchdog": streamWatchdogConfig,
  }));
}

function createPluginClient(options: {
  sessionMetadata?: { agent?: string; slug?: string };
  logDelayMs?: number;
  throwOnSessionGet?: boolean;
  throwOnLog?: boolean;
  throwOnToast?: boolean;
} = {}): {
  client: PluginClient;
  abortedSessions: string[];
  logBodies: LogBody[];
  toastBodies: ToastBody[];
  getSessionCalls: number;
} {
  const abortedSessions: string[] = [];
  const logBodies: LogBody[] = [];
  const toastBodies: ToastBody[] = [];
  const state = { getSessionCalls: 0 };

  const client = {
    app: {
      log: async ({ body }: { body: LogBody }) => {
        if (options.throwOnLog) {
          throw new Error("app.log unavailable");
        }

        if (options.logDelayMs !== undefined) {
          await sleep(options.logDelayMs);
        }

        logBodies.push(body);
      },
    },
    session: {
      abort: async ({ path }: { path: { id: string } }) => {
        abortedSessions.push(path.id);
        return { data: true };
      },
      get: async () => {
        state.getSessionCalls += 1;

        if (options.throwOnSessionGet) {
          throw new Error("session.get unavailable");
        }

        return { data: options.sessionMetadata ?? {} };
      },
    },
    tui: {
      showToast: async ({ body }: { body: ToastBody }) => {
        if (options.throwOnToast) {
          throw new Error("toast unavailable");
        }

        toastBodies.push(body);
      },
    },
  } satisfies Partial<PluginClient>;

  return {
    client: client as PluginClient,
    abortedSessions,
    logBodies,
    toastBodies,
    get getSessionCalls() {
      return state.getSessionCalls;
    },
  };
}

function busyEvent(sessionID: string): PluginEvent {
  return {
    event: {
      type: "session.status",
      properties: {
        sessionID,
        status: { type: "busy" },
      },
    },
  } as PluginEvent;
}

function partUpdatedEvent(
  sessionID: string,
  part: {
    type?: string;
    tool?: string;
    state?: { status?: string };
    text?: string;
  } = {},
): PluginEvent {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID,
          type: part.type ?? "text",
          ...(part.tool ? { tool: part.tool } : {}),
          ...(part.state ? { state: part.state } : {}),
          ...(part.text ? { text: part.text } : {}),
        },
      },
    },
  } as PluginEvent;
}

function sessionIdleEvent(sessionID: string): PluginEvent {
  return {
    event: {
      type: "session.idle",
      properties: {
        sessionID,
      },
    },
  } as PluginEvent;
}

function sessionErrorEvent(sessionID: string): PluginEvent {
  return {
    event: {
      type: "session.error",
      properties: {
        sessionID,
      },
    },
  } as PluginEvent;
}

function findIncidentLog(logBodies: readonly LogBody[], message: "WARN" | "RESUME" | "ABORT" | "NOOP"): LogBody | undefined {
  return logBodies.find((entry) => entry.message === message);
}

function findTrackingStartLog(logBodies: readonly LogBody[]): LogBody | undefined {
  return logBodies.find((entry) => entry.message === "tracking-start");
}

function findToastByTitle(toastBodies: readonly ToastBody[], title: string): ToastBody | undefined {
  return toastBodies.find((body) => body.title === title);
}

function mockDateNow(initialNow: number): (() => void) & { clock: { now: number } } {
  const originalDateNow = Date.now;
  const clock = { now: initialNow };
  const restore = (() => {
    Date.now = originalDateNow;
  }) as (() => void) & { clock: { now: number } };

  Date.now = () => clock.now;
  restore.clock = clock;
  return restore;
}

async function waitForMetadata(
  client: { getSessionCalls: number },
  expectedCalls = 1,
): Promise<void> {
  await waitUntil(() => client.getSessionCalls >= expectedCalls);
  await sleep(0);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = originalNow() + 500;

  while (!predicate()) {
    if (originalNow() > deadline) {
      throw new Error("Timed out waiting for condition");
    }

    await sleep(1);
  }
}

function originalNow(): number {
  return Number(new Date());
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
