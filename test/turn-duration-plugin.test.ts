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

describe("turn duration plugin wiring", () => {
  test("logs fast completed turns without showing a toast below the minimum", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir);
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      clock.now = 4_000;
      await plugin.event?.(idleEvent("session-1"));

      expect(durationLogs(client.logBodies)).toEqual([{
        service: "stream-watchdog",
        level: "info",
        message: "TURN_DURATION",
        extra: {
          sessionID: "session-1",
          agent: "coder",
          durationMs: 3_000,
        },
      }]);
      expect(turnDoneToasts(client.toastBodies)).toEqual([]);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("shows info and warning toasts at configured duration thresholds", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(10_000);

    try {
      await writeDurationConfig(tempDir);
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);

      await plugin.event?.(busyEvent("normal-turn"));
      await waitForMetadata(client);
      clock.now = 16_000;
      await plugin.event?.(idleEvent("normal-turn"));

      clock.now = 20_000;
      await plugin.event?.(busyEvent("slow-turn"));
      await waitForMetadata(client, 2);
      clock.now = 51_000;
      await plugin.event?.(idleEvent("slow-turn"));

      expect(turnDoneToasts(client.toastBodies)).toEqual([
        {
          title: "⌛ Turn done",
          message: "coder · 6s",
          variant: "info",
          duration: 4000,
        },
        {
          title: "⌛ Turn done · slow",
          message: "coder · 31s",
          variant: "warning",
          duration: 4000,
        },
      ]);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("retains lastTurnMs for the next active status and prunes it on delete", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir);
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      clock.now = 7_000;
      await plugin.event?.(idleEvent("session-1"));

      clock.now = 8_000;
      await plugin.event?.(busyEvent("session-1"));
      expect(await statusTool.execute({ verbose: false })).toContain("lastTurnMs=6000");

      await plugin.event?.(deletedEvent("session-1"));
      clock.now = 9_000;
      await plugin.event?.(busyEvent("session-1"));
      expect(await statusTool.execute({ verbose: false })).not.toContain("lastTurnMs=");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("omits lastTurnMs for active first turn before any completion", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir);
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);

      expect(await statusTool.execute({ verbose: false })).not.toContain("lastTurnMs=");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("suppresses duration logs and toasts when disabled but keeps lastTurnMs for status", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir, { enabled: false });
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      clock.now = 7_000;
      await plugin.event?.(idleEvent("session-1"));

      expect(durationLogs(client.logBodies)).toEqual([]);
      expect(turnDoneToasts(client.toastBodies)).toEqual([]);

      clock.now = 8_000;
      await plugin.event?.(busyEvent("session-1"));
      expect(await statusTool.execute({ verbose: false })).toContain("lastTurnMs=6000");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("suppresses TURN_DURATION logs when global log is disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir, {}, { log: false });
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      clock.now = 7_000;
      await plugin.event?.(idleEvent("session-1"));

      expect(durationLogs(client.logBodies)).toEqual([]);
      expect(turnDoneToasts(client.toastBodies)).toEqual([
        {
          title: "⌛ Turn done",
          message: "coder · 6s",
          variant: "info",
          duration: 4000,
        },
      ]);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("suppresses turn-done toasts when global toast is disabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir, {}, { toast: false });
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      clock.now = 7_000;
      await plugin.event?.(idleEvent("session-1"));

      expect(durationLogs(client.logBodies)).toEqual([{
        service: "stream-watchdog",
        level: "info",
        message: "TURN_DURATION",
        extra: {
          sessionID: "session-1",
          agent: "coder",
          durationMs: 6_000,
        },
      }]);
      expect(turnDoneToasts(client.toastBodies)).toEqual([]);
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("counts WARN scan transitions and RESUME on first post-warn activity", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 1,
          abortThresholdMs: 0,
          tickMs: 10,
          log: false,
          toast: false,
          duration: {
            enabled: false,
            minToastMs: 5_000,
            slowToastMs: 30_000,
          },
        },
      }));

      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      await waitUntilStatusContains(statusTool, "warns=1");

      await plugin.event?.(partUpdatedEvent("session-1", "assistant"));
      await plugin.event?.(idleEvent("session-1"));

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("totals warns=1 resumes=1 aborts=0");
      expect(status).toContain("byAgent agent=coder warns=1 resumes=1 aborts=0");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rearms after same-millisecond WARN and first post-warn activity", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 1,
          abortThresholdMs: 0,
          tickMs: 10,
          log: false,
          toast: false,
          duration: {
            enabled: false,
            minToastMs: 5_000,
            slowToastMs: 30_000,
          },
        },
      }));

      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);

      clock.now = 1_001;
      await waitUntilStatusContains(statusTool, "state=warned");
      await plugin.event?.(partUpdatedEvent("session-1", "assistant"));

      clock.now = 31_003;
      await plugin.event?.(partUpdatedEvent("session-1", "text"));
      await waitUntilStatusContains(statusTool, "type=RESUME");

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("state=tracking");
      expect(status).toContain("totals warns=1 resumes=1 aborts=0");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("records completed turn duration stats under resolved agent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-test-"));
    const restoreDateNow = mockDateNow(1_000);

    try {
      await writeDurationConfig(tempDir, { enabled: false });
      const clock = restoreDateNow.clock;
      const client = createPluginClient({ sessionMetadata: { agent: "coder" } });
      const plugin = await createPlugin(tempDir, client.client);
      const statusTool = plugin.tool?.watchdog_status as StatusTool;

      await plugin.event?.(busyEvent("session-1"));
      await waitForMetadata(client);
      clock.now = 7_000;
      await plugin.event?.(idleEvent("session-1"));

      const status = await statusTool.execute({ verbose: true });
      expect(status).toContain("durationCount=1");
      expect(status).toContain("durationP50Ms=6000");
      expect(status).toContain("durationP95Ms=6000");
      expect(status).toContain("durationMaxMs=6000");
    } finally {
      restoreDateNow();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function createPlugin(tempDir: string, client: PluginClient): Promise<Awaited<ReturnType<Plugin>>> {
  return await StreamWatchdog({
    client,
    directory: tempDir,
    project: tempDir,
    worktree: tempDir,
  } satisfies PluginInput);
}

async function writeDurationConfig(
  tempDir: string,
  durationOverrides: Partial<{ enabled: boolean; minToastMs: number; slowToastMs: number }> = {},
  globalOverrides: Partial<{ log: boolean; toast: boolean }> = {},
): Promise<void> {
  const durationConfig = {
    enabled: true,
    minToastMs: 5_000,
    slowToastMs: 30_000,
    ...durationOverrides,
  };

  await writeFile(join(tempDir, "opencode.json"), JSON.stringify({
    "stream-watchdog": {
      warnThresholdMs: 90_000,
      abortThresholdMs: 0,
      tickMs: 10_000,
      ...globalOverrides,
      duration: durationConfig,
    },
  }));
}

function createPluginClient(options: {
  sessionMetadata?: { agent?: string; slug?: string };
} = {}): {
  client: PluginClient;
  logBodies: LogBody[];
  toastBodies: ToastBody[];
  getSessionCalls: number;
} {
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
      abort: async () => ({ data: true }),
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

function idleEvent(sessionID: string): PluginEvent {
  return {
    event: {
      type: "session.idle",
      properties: { sessionID },
    },
  } as PluginEvent;
}

function partUpdatedEvent(sessionID: string, kind = "text"): PluginEvent {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID,
          kind,
        },
      },
    },
  } as PluginEvent;
}

function deletedEvent(sessionID: string): PluginEvent {
  return {
    event: {
      type: "session.deleted",
      properties: { info: { id: sessionID } },
    },
  } as PluginEvent;
}

function durationLogs(logBodies: readonly LogBody[]): LogBody[] {
  return logBodies.filter((entry) => entry.message === "TURN_DURATION");
}

function turnDoneToasts(toastBodies: readonly ToastBody[]): ToastBody[] {
  return toastBodies.filter((body) => body.title?.startsWith("⌛ Turn done") === true);
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

async function waitUntilStatusContains(statusTool: StatusTool, needle: string): Promise<void> {
  const deadline = originalNow() + 500;

  while (true) {
    const status = await statusTool.execute({ verbose: true });
    if (status.includes(needle)) {
      return;
    }

    if (originalNow() > deadline) {
      throw new Error(`Timed out waiting for status containing: ${needle}`);
    }

    await sleep(1);
  }
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
