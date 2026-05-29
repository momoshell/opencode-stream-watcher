import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadWatchdogConfig } from "../src/config.js";
import { buildWarnToastBody, normalizeAgent, normalizeLastPartKind, toIdleSeconds } from "../src/notify.js";
import { createTrackedSessions, scanTrackedSessions, startTracking } from "../src/state.js";
import { buildWatchdogStatus, recordRecentWatchdogTransitions } from "../src/tools.js";
import type { StallTransition, TrackedSession, WatchdogConfig } from "../src/types.js";

type ThresholdScanConfig = Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs" | "perAgent">;

describe("config edge cases", () => {
  test("uses project valid overrides but resets invalid project scalars to defaults", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "stream-watchdog-edge-config-"));
    const globalConfigPath = join(tempDir, "global.json");
    const projectConfigPath = join(tempDir, "project.json");
    const logMessages: string[] = [];

    try {
      await writeFile(globalConfigPath, JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: 120_000,
          abortThresholdMs: 300_000,
          tickMs: 15_000,
          toast: false,
          log: false,
        },
      }));
      await writeFile(projectConfigPath, JSON.stringify({
        "stream-watchdog": {
          warnThresholdMs: "bad",
          abortThresholdMs: 0,
          tickMs: -1,
          toast: "bad",
          log: true,
        },
      }));

      const config = await loadWatchdogConfig({
        globalConfigPath,
        projectConfigPath,
        logger: (message) => logMessages.push(message),
      });

      expect(config.warnThresholdMs).toBe(90_000);
      expect(config.abortThresholdMs).toBe(0);
      expect(config.tickMs).toBe(10_000);
      expect(config.toast).toBe(true);
      expect(config.log).toBe(true);
      expect(logMessages).toContain(
        "Invalid stream-watchdog.warnThresholdMs value; expected positive number. Using fallback.",
      );
      expect(logMessages).toContain(
        "Invalid stream-watchdog.tickMs value; expected positive number. Using fallback.",
      );
      expect(logMessages).toContain(
        "Invalid stream-watchdog.toast value; expected boolean. Using fallback.",
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("scanTrackedSessions edge boundaries", () => {
  test("warns at exact threshold once and repeated scans do not duplicate transitions", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-warn-boundary", { agent: "coder" }, 0);
    const config: ThresholdScanConfig = {
      warnThresholdMs: 90_000,
      abortThresholdMs: 180_000,
      perAgent: {},
    };

    const beforeBoundary = scanTrackedSessions(sessions, config, 89_999);
    const atBoundary = scanTrackedSessions(sessions, config, 90_000);
    const repeatedAtBoundary = scanTrackedSessions(sessions, config, 90_000);

    expect(beforeBoundary).toEqual([]);
    expect(atBoundary).toHaveLength(1);
    expect(atBoundary[0]?.from).toBe("tracking");
    expect(atBoundary[0]?.to).toBe("warned");
    expect(repeatedAtBoundary).toEqual([]);
    expect(tracked.state).toBe("warned");
  });

  test("aborts before warning when abort and warn thresholds are equal", () => {
    const sessions = createTrackedSessions();
    startTracking(sessions, "session-abort-priority", { agent: "coder" }, 0);
    const config: ThresholdScanConfig = {
      warnThresholdMs: 90_000,
      abortThresholdMs: 90_000,
      perAgent: {},
    };

    const transitions = scanTrackedSessions(sessions, config, 90_000);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.from).toBe("tracking");
    expect(transitions[0]?.to).toBe("aborted");
    expect(scanTrackedSessions(sessions, config, 100_000)).toEqual([]);
  });

  test("aborts at exact abort threshold once after warning", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-abort-boundary", { agent: "coder" }, 0);
    const config: ThresholdScanConfig = {
      warnThresholdMs: 90_000,
      abortThresholdMs: 120_000,
      perAgent: {},
    };

    const warnTransition = scanTrackedSessions(sessions, config, 90_000);
    const beforeAbort = scanTrackedSessions(sessions, config, 119_999);
    const atAbort = scanTrackedSessions(sessions, config, 120_000);
    const repeatedAfterAbort = scanTrackedSessions(sessions, config, 130_000);

    expect(warnTransition).toHaveLength(1);
    expect(warnTransition[0]?.to).toBe("warned");
    expect(beforeAbort).toEqual([]);
    expect(atAbort).toHaveLength(1);
    expect(atAbort[0]?.from).toBe("warned");
    expect(atAbort[0]?.to).toBe("aborted");
    expect(repeatedAfterAbort).toEqual([]);
    expect(tracked.state).toBe("aborted");
  });
});

describe("notify fallback formatting", () => {
  test("formats WARN toast with unknown fallbacks and clamps negative idle", () => {
    const toast = buildWarnToastBody({
      sessionID: "session-fallback",
      slug: "   ",
      agent: "",
      idleMs: -250,
      lastPartKind: "\t",
    });

    expect(toast.message).toBe(
      'Agent: unknown\nSession: session-fallback\nIdle: 0s\nLast part: unknown\nEsc to interrupt · ask Huginn "kill unknown" for selective abort',
    );
  });

  test("does not fallback when agent and part values are non-empty", () => {
    expect(normalizeAgent("coder")).toBe("coder");
    expect(normalizeLastPartKind("tool")).toBe("tool");
    expect(toIdleSeconds(3_400)).toBe(3);
  });
});

describe("watchdog status tool edge cases", () => {
  test("caps recent events at ten and formats unknown agents", () => {
    const recentEvents = [];

    recordRecentWatchdogTransitions(
      recentEvents,
      Array.from({ length: 12 }, (_, index) => {
        const eventNumber = index + 1;
        return transition({
          sessionID: `session-${eventNumber}`,
          at: eventNumber * 1_000,
          to: eventNumber % 3 === 0 ? "aborted" : "warned",
          agent: eventNumber === 12 ? undefined : `agent-${eventNumber}`,
        });
      }),
    );

    expect(recentEvents).toHaveLength(10);
    expect(recentEvents[0]).toEqual({
      time: 3_000,
      type: "ABORT",
      sessionID: "session-3",
      agent: "agent-3",
    });
    expect(recentEvents[9]).toEqual({
      time: 12_000,
      type: "ABORT",
      sessionID: "session-12",
      agent: "unknown",
    });

    const status = buildWatchdogStatus(new Map(), recentEvents, 20_000, false);

    expect(status).toContain("stream-watchdog: no tracked sessions.");
    expect(status).toContain("Recent events (oldest → newest):");
    expect(status).not.toContain("sessionID=session-1 agent=agent-1");
    expect(status).toContain("time=1970-01-01T00:00:03.000Z type=ABORT sessionID=session-3 agent=agent-3");
    expect(status).toContain("time=1970-01-01T00:00:12.000Z type=ABORT sessionID=session-12 agent=unknown");
  });

  test("formats verbose tracked sessions with clamped idle and ISO timestamps", () => {
    const sessions = new Map<string, TrackedSession>([
      [
        "future-activity",
        trackedStatusSession({
          sessionID: "future-activity",
          agent: "coder",
          lastActivity: 2_000,
          stateSince: 500,
          lastPartKind: "tool",
          lastTurnMs: 7_500,
        }),
      ],
    ]);

    const status = buildWatchdogStatus(sessions, [], 1_000, true);

    expect(status).toContain("stream-watchdog: tracking 1 session.");
    expect(status).toContain(
      "- sessionID=future-activity agent=coder slug=unknown idleMs=0 lastPartKind=tool state=tracking lastTurnMs=7500 lastActivity=1970-01-01T00:00:02.000Z stateSince=1970-01-01T00:00:00.500Z",
    );
    expect(status).toContain("Recent events: none.");
  });
});

function transition(input: {
  sessionID: string;
  at: number;
  to: "warned" | "aborted";
  agent?: string;
}): StallTransition {
  return {
    sessionID: input.sessionID,
    from: "tracking",
    to: input.to,
    at: input.at,
    idleMs: input.at,
    tracked: trackedStatusSession({
      sessionID: input.sessionID,
      agent: input.agent,
      lastActivity: 0,
      stateSince: 0,
    }),
  };
}

function trackedStatusSession(input: {
  sessionID: string;
  agent?: string;
  lastActivity: number;
  stateSince: number;
  lastPartKind?: TrackedSession["lastPartKind"];
  lastTurnMs?: number;
}): TrackedSession {
  return {
    sessionID: input.sessionID,
    agent: input.agent,
    callStart: input.lastActivity,
    lastActivity: input.lastActivity,
    lastPartKind: input.lastPartKind,
    lastTurnMs: input.lastTurnMs,
    state: "tracking",
    stateSince: input.stateSince,
  };
}
