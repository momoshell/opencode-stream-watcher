import { describe, expect, test } from "bun:test";
import type { Part } from "@opencode-ai/sdk";

import {
  createTrackedSessions,
  recordPartActivity,
  resolveNoopWatch,
  snapshotTrackedSession,
  startTracking,
} from "../src/state.js";
import type { WatchdogConfig } from "../src/types.js";

describe("no-op detection state helpers", () => {
  test("marks mutation only after completed edit tool parts", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-noop-mutation", { agent: "coder" }, 1_000);

    recordPartActivity(sessions, "session-noop-mutation", partUpdated({
      type: "tool",
      tool: "apply_patch",
      state: { status: "running" },
    }), 1_100);
    expect(tracked.mutated).toBeFalse();

    recordPartActivity(sessions, "session-noop-mutation", partUpdated({
      type: "tool",
      tool: "shell",
      state: { status: "completed" },
    }), 1_200);
    expect(tracked.mutated).toBeFalse();

    recordPartActivity(sessions, "session-noop-mutation", partUpdated({
      type: "tool",
      tool: "apply_patch",
      state: { status: "completed" },
    }), 1_300);
    expect(tracked.mutated).toBeTrue();
  });

  test("tracks blocker state and clears it on non-blocker text", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-noop-blocker", { agent: "coder" }, 1_000);

    recordPartActivity(
      sessions,
      "session-noop-blocker",
      partUpdated({ type: "text", text: "  BLOCKER: waiting for credentials" }),
      1_100,
    );
    expect(tracked.endedWithBlocker).toBeTrue();

    recordPartActivity(
      sessions,
      "session-noop-blocker",
      partUpdated({ type: "text", text: "Proceeding after clarification" }),
      1_200,
    );
    expect(tracked.endedWithBlocker).toBeFalse();
  });

  test("snapshots no-op flags without mutating captured values", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-noop-snapshot", { agent: "coder" }, 1_000);

    tracked.mutated = true;
    tracked.endedWithBlocker = true;
    tracked.lastPartKind = "tool";

    const snapshot = snapshotTrackedSession(tracked);

    tracked.mutated = false;
    tracked.endedWithBlocker = false;
    tracked.lastPartKind = "text";

    expect(snapshot).toEqual({
      ...tracked,
      mutated: true,
      endedWithBlocker: true,
      lastPartKind: "tool",
    });
  });

  test("resolveNoopWatch gates by global flag, default watched agent, blocker, mutation, and per-agent override", () => {
    const sessions = createTrackedSessions();
    const tracked = startTracking(sessions, "session-noop-gates", { agent: "coder" }, 1_000);
    const config: Pick<WatchdogConfig, "noop" | "perAgent"> = {
      noop: { enabled: true },
      perAgent: {},
    };

    expect(resolveNoopWatch(tracked, config)).toBeTrue();
    expect(resolveNoopWatch({ ...tracked, mutated: true }, config)).toBeFalse();
    expect(resolveNoopWatch({ ...tracked, endedWithBlocker: true }, config)).toBeFalse();
    expect(resolveNoopWatch({ ...tracked, agent: "code-reviewer" }, config)).toBeFalse();
    expect(resolveNoopWatch({ ...tracked, agent: undefined }, config)).toBeFalse();
    expect(resolveNoopWatch(tracked, { ...config, noop: { enabled: false } })).toBeFalse();
    expect(resolveNoopWatch(tracked, {
      ...config,
      perAgent: {
        coder: {
          noopWatch: false,
        },
      },
    })).toBeFalse();
  });
});

function partUpdated(part: Record<string, unknown>): Part {
  return part as unknown as Part;
}
