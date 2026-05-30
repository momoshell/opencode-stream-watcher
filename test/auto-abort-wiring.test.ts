import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";

import { buildAbortToastBody } from "../src/notify.js";
import { StreamWatchdog } from "../src/plugin.js";
import { createTrackedSessions, scanTrackedSessions, startTracking } from "../src/state.js";
import type { WatchdogConfig } from "../src/types.js";

type ThresholdScanConfig = Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs" | "perAgent">;
type PluginInput = Parameters<Plugin>[0];
type PluginClient = PluginInput["client"];
type PluginEvent = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["event"]>>[0];
type StatusTool = {
  execute: (args: { verbose?: boolean }) => Promise<string>;
};
type AbortTool = {
  execute: (
    args: { sessionID?: string },
    context: { metadata: (input: { metadata: Record<string, string> }) => void },
  ) => Promise<string>;
};
type ToastBody = {
  title?: string;
  message: string;
  variant: "warning" | "success" | "error";
  duration?: number;
};
type LogBody = {
  service: "stream-watchdog";
  level: "info" | "warn";
  message: string;
  extra?: Record<string, string | number>;
};
type AbortResult = boolean | "throw";

const BASE_THRESHOLDS: ThresholdScanConfig = {
  warnThresholdMs: 90_000,
  abortThresholdMs: 60_000,
  perAgent: {},
};

describe("auto-abort wiring", () => {
  test("transitions directly from tracking to aborted when abort threshold precedes warn", () => {
    const sessions = createTrackedSessions();
    startTracking(sessions, "session-1", { agent: "coder" }, 0);

    const transitions = scanTrackedSessions(sessions, BASE_THRESHOLDS, 60_000);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.from).toBe("tracking");
    expect(transitions[0]?.to).toBe("aborted");
    expect(transitions[0]?.idleMs).toBe(60_000);
    expect(sessions.get("session-1")?.state).toBe("aborted");
  });

  test("chooses abort over warn when both thresholds are reached in the same scan", () => {
    const sessions = createTrackedSessions();
    startTracking(sessions, "session-1", { agent: "coder" }, 0);

    const transitions = scanTrackedSessions(
      sessions,
      { ...BASE_THRESHOLDS, warnThresholdMs: 60_000 },
      60_000,
    );

    expect(transitions[0]?.from).toBe("tracking");
    expect(transitions[0]?.to).toBe("aborted");
  });

  test("builds the issue-required abort toast body", () => {
    expect(buildAbortToastBody({
      sessionID: "session-1",
      slug: "stalling-task",
      agent: "coder",
      idleMs: 60_999,
    })).toEqual({
      title: "🛑 Aborted stalled stream",
      message: "coder · stalling-task · aborted after 60s",
      variant: "error",
      duration: 8000,
    });
  });

  test("auto-aborts independently of log and toast settings", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 1,
          tickMs: 10,
          log: false,
          toast: false,
        },
      }));

      const client = createPluginClient();
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);

      await plugin.event?.(busyEvent("session-1"));
      await waitUntil(() => client.abortedSessions.includes("session-1"));

      expect(client.abortedSessions).toEqual(["session-1"]);
      expect(client.toastBodies).toEqual([]);
      expect(client.logBodies.some((entry) => entry.message === "ABORT")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("emits ABORT log and toast once only after SDK abort success", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 1,
          tickMs: 10,
          log: true,
          toast: true,
        },
      }));

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
      await waitUntil(() => client.toastBodies.some((body) => body.title === "🛑 Aborted stalled stream"));
      await sleep(30);

      const abortLogs = client.logBodies.filter((entry) => entry.message === "ABORT");
      const abortToasts = client.toastBodies.filter((body) => body.title === "🛑 Aborted stalled stream");

      expect(client.abortedSessions).toEqual(["session-1"]);
      expect(abortLogs).toEqual([{
        service: "stream-watchdog",
        level: "warn",
        message: "ABORT",
        extra: {
          sessionID: "session-1",
          agent: "coder",
          idleSeconds: 0,
          lastPartKind: "unknown",
        },
      }]);
      expect(abortToasts).toEqual([{
        title: "🛑 Aborted stalled stream",
        message: "coder · stalling-task · aborted after 0s",
        variant: "error",
        duration: 8000,
      }]);
      expect(await statusTool.execute({ verbose: true })).toContain("totals warns=0 resumes=0 aborts=1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("skips ABORT log and toast when SDK abort fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 1,
          tickMs: 10,
          log: true,
          toast: true,
        },
      }));

      const client = createPluginClient({ abortSucceeds: false });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitUntil(() => client.abortedSessions.includes("session-1"));
      await sleep(30);

      expect(client.abortedSessions).toContain("session-1");
      expect(client.toastBodies).toEqual([]);
      expect(client.logBodies.some((entry) => entry.message === "ABORT")).toBe(false);
      expect(await statusTool.execute({ verbose: true })).toContain("totals warns=0 resumes=0 aborts=0");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("counts manual abort only after SDK abort success", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 1,
          tickMs: 10,
          log: true,
          toast: false,
        },
      }));

      const client = createPluginClient({
        sessionMetadata: { agent: "coder" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;
      const abortTool = plugin.tool?.watchdog_abort as AbortTool;

      await plugin.event?.(busyEvent("session-1"));
      await sleep(0);
      await abortTool.execute(
        { sessionID: "session-1" },
        { metadata: () => undefined },
      );
      await sleep(30);

      expect(client.abortedSessions).toEqual(["session-1"]);
      expect(await statusTool.execute({ verbose: true })).toContain("stream-watchdog: no tracked sessions.");
      expect(await statusTool.execute({ verbose: true })).toContain("totals warns=0 resumes=0 aborts=1");
      expect(await statusTool.execute({ verbose: true })).toContain("byAgent agent=coder warns=0 resumes=0 aborts=1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reconciles omitted-argument manual abort using the resolved longest-idle target", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 90_000,
          tickMs: 10,
          log: true,
          toast: false,
        },
      }));

      const client = createPluginClient({
        sessionMetadata: { agent: "coder" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;
      const abortTool = plugin.tool?.watchdog_abort as AbortTool;

      await plugin.event?.(busyEvent("session-1"));
      await sleep(20);
      await plugin.event?.(busyEvent("session-2"));

      await abortTool.execute({}, { metadata: () => undefined });

      const status = await statusTool.execute({ verbose: true });
      expect(client.abortedSessions).toEqual(["session-1"]);
      expect(status).toContain("stream-watchdog: tracking 1 session.");
      expect(status).toContain("sessionID=session-2");
      expect(status).not.toContain("sessionID=session-1");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("does not count manual abort when SDK abort fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 0,
          tickMs: 10,
          log: true,
          toast: false,
        },
      }));

      const client = createPluginClient({
        abortSucceeds: false,
        sessionMetadata: { agent: "coder" },
      });
      const plugin = await StreamWatchdog({
        client: client.client,
        directory: tempDir,
        project: tempDir,
        worktree: tempDir,
      } satisfies PluginInput);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;
      const abortTool = plugin.tool?.watchdog_abort as AbortTool;

      await plugin.event?.(busyEvent("session-1"));
      await sleep(0);
      await abortTool.execute(
        { sessionID: "session-1" },
        { metadata: () => undefined },
      );

      expect(client.abortedSessions).toEqual(["session-1"]);
      expect(await statusTool.execute({ verbose: true })).toContain("stream-watchdog: tracking 1 session.");
      expect(await statusTool.execute({ verbose: true })).toContain("sessionID=session-1");
      expect(await statusTool.execute({ verbose: true })).toContain("totals warns=0 resumes=0 aborts=0");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("retries direct auto-abort after false SDK result before recording ABORT", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 90_000,
          abortThresholdMs: 1,
          tickMs: 50,
          log: true,
          toast: true,
        },
      }));

      const client = createPluginClient({
        abortResults: [false, true],
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
      await waitUntil(() => client.abortedSessions.length === 1);

      const statusAfterFailure = await statusTool.execute({ verbose: true });
      expect(statusAfterFailure).toContain("totals warns=0 resumes=0 aborts=0");
      expect(statusAfterFailure).not.toContain("type=ABORT");
      expect(client.logBodies.some((entry) => entry.message === "ABORT")).toBe(false);
      expect(client.toastBodies.some((body) => body.title === "🛑 Aborted stalled stream")).toBe(false);

      await waitUntil(() => client.abortedSessions.length === 2);

      const statusAfterSuccess = await statusTool.execute({ verbose: true });
      expect(client.abortedSessions).toEqual(["session-1", "session-1"]);
      expect(statusAfterSuccess).toContain("totals warns=0 resumes=0 aborts=1");
      expect(statusAfterSuccess).toContain("type=ABORT");
      expect(client.logBodies.filter((entry) => entry.message === "ABORT")).toHaveLength(1);
      expect(client.toastBodies.filter((body) => body.title === "🛑 Aborted stalled stream")).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("retries warned auto-abort after thrown SDK result before recording ABORT", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 1,
          abortThresholdMs: 250,
          tickMs: 25,
          log: true,
          toast: true,
        },
      }));

      const client = createPluginClient({
        abortResults: ["throw", true],
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
      await waitUntil(() => client.toastBodies.some((body) => body.title === "⏸ Stream stalled"));
      await waitUntil(() => client.abortedSessions.length === 1);

      const statusAfterFailure = await statusTool.execute({ verbose: true });
      expect(statusAfterFailure).toContain("totals warns=1 resumes=0 aborts=0");
      expect(statusAfterFailure).not.toContain("type=ABORT");
      expect(client.logBodies.some((entry) => entry.message === "ABORT")).toBe(false);
      expect(client.toastBodies.filter((body) => body.title === "⏸ Stream stalled")).toHaveLength(1);

      await waitUntil(() => client.abortedSessions.length === 2);

      const statusAfterSuccess = await statusTool.execute({ verbose: true });
      expect(client.abortedSessions).toEqual(["session-1", "session-1"]);
      expect(statusAfterSuccess).toContain("totals warns=1 resumes=0 aborts=1");
      expect(statusAfterSuccess).toContain("type=ABORT");
      expect(client.logBodies.filter((entry) => entry.message === "ABORT")).toHaveLength(1);
      expect(client.toastBodies.filter((body) => body.title === "🛑 Aborted stalled stream")).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createPluginClient(options: {
  abortSucceeds?: boolean;
  abortResults?: AbortResult[];
  sessionMetadata?: { agent?: string; slug?: string };
} = {}): {
  client: PluginClient;
  abortedSessions: string[];
  logBodies: LogBody[];
  toastBodies: ToastBody[];
} {
  const abortedSessions: string[] = [];
  const logBodies: LogBody[] = [];
  const toastBodies: ToastBody[] = [];

  const client = {
    app: {
      log: async ({ body }: { body: LogBody }) => {
        logBodies.push(body);
      },
    },
    session: {
      abort: async ({ path }: { path: { id: string } }) => {
        abortedSessions.push(path.id);
        const nextResult = options.abortResults?.shift();
        if (nextResult === "throw") {
          throw new Error("simulated abort failure");
        }

        if (nextResult !== undefined) {
          return { data: nextResult };
        }

        return { data: options.abortSucceeds ?? true };
      },
      get: async () => ({ data: options.sessionMetadata ?? {} }),
    },
    tui: {
      showToast: async ({ body }: { body: ToastBody }) => {
        toastBodies.push(body);
      },
    },
  } satisfies Partial<PluginClient>;

  return {
    client: client as PluginClient,
    abortedSessions,
    logBodies,
    toastBodies,
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }

    await sleep(5);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
