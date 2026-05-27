import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StreamWatchdog } from "../dist/plugin.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempProject(config) {
  const dir = await mkdtemp(join(tmpdir(), "stream-watchdog-plugin-"));
  tempDirs.push(dir);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({ "stream-watchdog": config }),
    "utf8",
  );
  return dir;
}

function createClient() {
  const logs = [];
  const toasts = [];

  return {
    logs,
    toasts,
    client: {
      app: {
        log: async ({ body }) => {
          logs.push(body);
          return true;
        },
      },
      tui: {
        showToast: async ({ body }) => {
          toasts.push(body);
          return true;
        },
      },
      session: {
        get: async () => ({
          data: {
            agent: "agent-x",
            slug: "agent-x-run",
          },
        }),
      },
    },
  };
}

async function startPlugin(config) {
  const projectRoot = await createTempProject(config);
  const fake = createClient();
  const hooks = await StreamWatchdog({
    project: { path: projectRoot },
    client: fake.client,
    directory: projectRoot,
    worktree: projectRoot,
  });

  return { ...fake, hooks };
}

async function startBusySession(hooks, sessionID) {
  await hooks.event({
    event: {
      type: "session.status",
      properties: {
        sessionID,
        status: { type: "busy" },
      },
    },
  });
}

async function stopSession(hooks, sessionID) {
  await hooks.event({
    event: {
      type: "session.idle",
      properties: { sessionID },
    },
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 500;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("timed out waiting for plugin tick");
}

describe("StreamWatchdog WARN gating", () => {
  test("toast enabled and log disabled emits WARN toast without WARN log", async () => {
    const { hooks, logs, toasts } = await startPlugin({
      warnThresholdMs: 5,
      abortThresholdMs: 0,
      tickMs: 5,
      toast: true,
      log: false,
    });

    await startBusySession(hooks, "session-toast-only");
    await waitFor(() => toasts.length === 1);
    await stopSession(hooks, "session-toast-only");

    expect(toasts).toEqual([
      expect.objectContaining({
        variant: "warning",
        title: "⏸ Stream stalled",
        duration: 0,
      }),
    ]);
    expect(logs.some((entry) => entry.message === "WARN")).toBe(false);
  });

  test("log enabled and toast disabled emits WARN log without toast", async () => {
    const { hooks, logs, toasts } = await startPlugin({
      warnThresholdMs: 5,
      abortThresholdMs: 0,
      tickMs: 5,
      toast: false,
      log: true,
    });

    await startBusySession(hooks, "session-log-only");
    await waitFor(() => logs.some((entry) => entry.message === "WARN"));
    await stopSession(hooks, "session-log-only");

    expect(logs.some((entry) => entry.message === "WARN")).toBe(true);
    expect(toasts).toEqual([]);
  });

  test("non-WARN transitions do not emit additional toasts", async () => {
    const { hooks, toasts } = await startPlugin({
      warnThresholdMs: 5,
      abortThresholdMs: 10,
      tickMs: 5,
      toast: true,
      log: false,
    });

    await startBusySession(hooks, "session-abort-no-toast");
    await waitFor(() => toasts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopSession(hooks, "session-abort-no-toast");

    expect(toasts).toHaveLength(1);
  });
});
