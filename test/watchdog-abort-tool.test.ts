import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";

import { createWatchdogAbortTool, executeWatchdogAbort } from "../src/tools.js";
import type { TrackedSession, WatchdogAbortResult } from "../src/types.js";

describe("watchdog_abort tool", () => {
  test("aborts an explicit tracked session and returns JSON-safe metadata", async () => {
    const sessions = new Map<string, TrackedSession>([
      ["session-1", trackedSession({ sessionID: "session-1", agent: "coder", lastActivity: 1_000 })],
    ]);
    const abortedSessions: string[] = [];
    const logs: WatchdogAbortResult[] = [];

    const result = await executeWatchdogAbort({
      trackedSessions: sessions,
      now: () => 6_000,
      abortSession: async (sessionID) => {
        abortedSessions.push(sessionID);
        return true;
      },
      logAbort: async ({ result: entry }) => {
        logs.push(entry);
      },
    }, { sessionID: "session-1" });

    expect(abortedSessions).toEqual(["session-1"]);
    expect(result).toEqual({
      aborted: true,
      sessionID: "session-1",
      agent: "coder",
      idleMs: 5_000,
    });
    expect(logs).toEqual([result]);
  });

  test("returns JSON output and publishes metadata through the tool context", async () => {
    const sessions = new Map<string, TrackedSession>([
      ["session-1", trackedSession({ sessionID: "session-1", agent: "coder", lastActivity: 1_000 })],
    ]);
    const metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }> = [];
    const tool = createWatchdogAbortTool({
      trackedSessions: sessions,
      now: () => 6_000,
      abortSession: async () => true,
    });

    const output = await tool.execute({ sessionID: "session-1" }, {
      sessionID: "parent-session",
      messageID: "message-1",
      agent: "huginn",
      directory: "/tmp/project",
      worktree: "/tmp/project",
      abort: new AbortController().signal,
      metadata: (input) => {
        metadataCalls.push(input);
      },
      ask: async () => undefined,
    } satisfies ToolContext);

    expect(output).toBe(JSON.stringify({
      aborted: true,
      sessionID: "session-1",
      agent: "coder",
      idleMs: 5_000,
    }));
    expect(metadataCalls).toEqual([{
      metadata: {
        aborted: true,
        sessionID: "session-1",
        agent: "coder",
        idleMs: 5_000,
      },
    }]);
  });

  test("aborts an explicit untracked session without claiming tracked metadata", async () => {
    const abortedSessions: string[] = [];

    const result = await executeWatchdogAbort({
      trackedSessions: new Map(),
      abortSession: async (sessionID) => {
        abortedSessions.push(sessionID);
        return true;
      },
    }, { sessionID: "missing-session" });

    expect(abortedSessions).toEqual(["missing-session"]);
    expect(result).toEqual({
      aborted: true,
      sessionID: "missing-session",
      idleMs: 0,
    });
  });

  test("selects the longest-idle tracked session deterministically when omitted", async () => {
    const sessions = new Map<string, TrackedSession>([
      ["newer", trackedSession({ sessionID: "newer", lastActivity: 5_000 })],
      ["tie-b", trackedSession({ sessionID: "tie-b", lastActivity: 1_000 })],
      ["tie-a", trackedSession({ sessionID: "tie-a", agent: "reviewer", lastActivity: 1_000 })],
    ]);
    const abortedSessions: string[] = [];

    const result = await executeWatchdogAbort({
      trackedSessions: sessions,
      now: () => 9_000,
      abortSession: async (sessionID) => {
        abortedSessions.push(sessionID);
        return true;
      },
    }, {});

    expect(abortedSessions).toEqual(["tie-a"]);
    expect(result).toEqual({
      aborted: true,
      sessionID: "tie-a",
      agent: "reviewer",
      idleMs: 8_000,
    });
  });

  test("does not abort when no session is provided and none are tracked", async () => {
    const abortedSessions: string[] = [];

    const result = await executeWatchdogAbort({
      trackedSessions: new Map(),
      abortSession: async (sessionID) => {
        abortedSessions.push(sessionID);
        return true;
      },
    }, {});

    expect(abortedSessions).toEqual([]);
    expect(result).toEqual({
      aborted: false,
      sessionID: "",
      idleMs: 0,
    });
  });

  test("returns aborted false and skips logging when the abort call fails", async () => {
    const sessions = new Map<string, TrackedSession>([
      ["session-1", trackedSession({ sessionID: "session-1", lastActivity: 1_000 })],
    ]);
    let logCount = 0;

    const result = await executeWatchdogAbort({
      trackedSessions: sessions,
      now: () => 2_000,
      abortSession: async () => false,
      logAbort: async () => {
        logCount += 1;
      },
    }, { sessionID: "session-1" });

    expect(result).toEqual({
      aborted: false,
      sessionID: "session-1",
      idleMs: 1_000,
    });
    expect(logCount).toBe(0);
  });
});

function trackedSession(input: {
  sessionID: string;
  agent?: string;
  lastActivity: number;
}): TrackedSession {
  return {
    sessionID: input.sessionID,
    agent: input.agent,
    lastActivity: input.lastActivity,
    state: "tracking",
    stateSince: input.lastActivity,
  };
}
