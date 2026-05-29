import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

      clock.now = 32_200;
      await waitUntil(() =>
        findIncidentLog(client.logBodies, "WARN") !== undefined &&
        findToastByTitle(client.toastBodies, "⏸ Stream stalled") !== undefined,
      );

      clock.now = 32_250;
      await plugin.event?.(partUpdatedEvent("session-1", "text"));
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
});

async function writeWatchdogConfig(tempDir: string): Promise<void> {
  await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
    "stream-watchdog": {
      warnThresholdMs: 31_100,
      abortThresholdMs: 31_300,
      tickMs: 5,
      log: true,
      toast: true,
      duration: {
        enabled: false,
        minToastMs: 5_000,
        slowToastMs: 30_000,
      },
    },
  }));
}

function createPluginClient(options: {
  sessionMetadata?: { agent?: string; slug?: string };
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
        return { data: options.sessionMetadata ?? {} };
      },
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

function partUpdatedEvent(sessionID: string, type = "text"): PluginEvent {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID,
          type,
        },
      },
    },
  } as PluginEvent;
}

function findIncidentLog(logBodies: readonly LogBody[], message: "WARN" | "RESUME" | "ABORT"): LogBody | undefined {
  return logBodies.find((entry) => entry.message === message);
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
