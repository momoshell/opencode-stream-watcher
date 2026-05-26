import { describe, expect, test } from "bun:test";
import {
  createTrackedSessions,
  recordPartActivity,
  scanTrackedSessions,
  startTracking,
  stopTracking,
} from "../dist/state.js";

const baseConfig = {
  warnThresholdMs: 90_000,
  abortThresholdMs: 0,
};

const resumeRearmMs = 30_000;

describe("state scanTrackedSessions", () => {
  test("transitions tracking -> warned at warn threshold when abort disabled", () => {
    const sessions = createTrackedSessions();
    const startedAt = 1_000;

    startTracking(sessions, "s1", {}, startedAt);

    scanTrackedSessions(sessions, baseConfig, startedAt + baseConfig.warnThresholdMs - 1);
    expect(sessions.get("s1")?.state).toBe("tracking");

    scanTrackedSessions(sessions, baseConfig, startedAt + baseConfig.warnThresholdMs);
    expect(sessions.get("s1")?.state).toBe("warned");
  });

  test("transitions warned -> tracking only after >30000ms of fresh activity", () => {
    const sessions = createTrackedSessions();
    const startedAt = 0;

    startTracking(sessions, "s2", {}, startedAt);
    scanTrackedSessions(sessions, baseConfig, startedAt + baseConfig.warnThresholdMs);
    expect(sessions.get("s2")?.state).toBe("warned");

    const freshActivityAt = startedAt + baseConfig.warnThresholdMs + 1;
    recordPartActivity(sessions, "s2", { type: "text" }, freshActivityAt);

    scanTrackedSessions(
      sessions,
      baseConfig,
      startedAt + baseConfig.warnThresholdMs + resumeRearmMs,
    );
    expect(sessions.get("s2")?.state).toBe("warned");

    scanTrackedSessions(
      sessions,
      baseConfig,
      startedAt + baseConfig.warnThresholdMs + resumeRearmMs + 1,
    );
    expect(sessions.get("s2")?.state).toBe("warned");

    scanTrackedSessions(
      sessions,
      baseConfig,
      startedAt + baseConfig.warnThresholdMs + resumeRearmMs + 2,
    );
    expect(sessions.get("s2")?.state).toBe("tracking");
  });

  test("does not clear immediately when first fresh activity arrives long after warning", () => {
    const sessions = createTrackedSessions();
    const startedAt = 0;

    startTracking(sessions, "s-long-resume", {}, startedAt);
    scanTrackedSessions(sessions, baseConfig, startedAt + baseConfig.warnThresholdMs);
    expect(sessions.get("s-long-resume")?.state).toBe("warned");

    const freshActivityAt = startedAt + baseConfig.warnThresholdMs + 35_000;
    recordPartActivity(sessions, "s-long-resume", { type: "text" }, freshActivityAt);

    scanTrackedSessions(sessions, baseConfig, freshActivityAt);
    expect(sessions.get("s-long-resume")?.state).toBe("warned");

    scanTrackedSessions(sessions, baseConfig, freshActivityAt + resumeRearmMs);
    expect(sessions.get("s-long-resume")?.state).toBe("warned");

    scanTrackedSessions(sessions, baseConfig, freshActivityAt + resumeRearmMs + 1);
    expect(sessions.get("s-long-resume")?.state).toBe("tracking");
  });

  test("does not transition after stopTracking removes session", () => {
    const sessions = createTrackedSessions();
    const startedAt = 9_000;

    startTracking(sessions, "s3", {}, startedAt);
    stopTracking(sessions, "s3");

    const transitions = scanTrackedSessions(
      sessions,
      baseConfig,
      startedAt + 500_000,
    );

    expect(sessions.has("s3")).toBe(false);
    expect(transitions).toEqual([]);
  });

  test("covers abort threshold when abortThresholdMs is enabled", () => {
    const sessions = createTrackedSessions();
    const startedAt = 20_000;
    const config = { ...baseConfig, abortThresholdMs: 180_000 };

    startTracking(sessions, "s4", {}, startedAt);

    scanTrackedSessions(sessions, config, startedAt + config.warnThresholdMs);
    expect(sessions.get("s4")?.state).toBe("warned");

    const events = scanTrackedSessions(
      sessions,
      config,
      startedAt + config.abortThresholdMs,
    );

    expect(Array.isArray(events)).toBe(true);
    expect(sessions.get("s4")?.state).toBe("aborted");
  });
});
