import { describe, expect, test } from "bun:test";

import { formatWatchdogStats, WatchdogStats } from "../src/stats.js";
import { buildWatchdogStatus } from "../src/tools.js";

describe("WatchdogStats", () => {
  test("tracks warns/resumes/aborts by agent with unknown fallback", () => {
    const stats = new WatchdogStats();

    stats.recordWarn("agent-a");
    stats.recordWarn("  ");
    stats.recordResume(undefined);
    stats.recordAbort(null);
    stats.recordAbort("agent-a");

    const snapshot = stats.snapshot();

    expect(snapshot.totals).toEqual({ warns: 2, resumes: 1, aborts: 2 });
    expect(snapshot.byAgent["agent-a"]).toEqual({
      warns: 1,
      resumes: 0,
      aborts: 1,
      duration: { count: 0, p50: 0, p95: 0, max: 0 },
    });
    expect(snapshot.byAgent.unknown).toEqual({
      warns: 1,
      resumes: 1,
      aborts: 1,
      duration: { count: 0, p50: 0, p95: 0, max: 0 },
    });
  });

  test("keeps independent 100-sample FIFOs per agent and computes nearest-rank percentiles", () => {
    const stats = new WatchdogStats();

    for (let sample = 1; sample <= 120; sample += 1) {
      stats.recordDuration("agent-a", sample);
      stats.recordDuration("agent-b", sample + 1000);
    }

    stats.recordDuration(" ", 5);

    const snapshot = stats.snapshot();

    expect(snapshot.byAgent["agent-a"]?.duration).toEqual({
      count: 100,
      p50: 70,
      p95: 115,
      max: 120,
    });

    expect(snapshot.byAgent["agent-b"]?.duration).toEqual({
      count: 100,
      p50: 1070,
      p95: 1115,
      max: 1120,
    });

    expect(snapshot.byAgent.unknown?.duration).toEqual({
      count: 1,
      p50: 5,
      p95: 5,
      max: 5,
    });
  });

  test("formats aggregate stats section", () => {
    const stats = new WatchdogStats();
    const lines = formatWatchdogStats(stats.snapshot());

    expect(lines).toEqual([
      "Aggregate stats:",
      "- totals warns=0 resumes=0 aborts=0",
      "- byAgent none",
    ]);
  });

  test("status output shows per-agent duration stats", () => {
    const stats = new WatchdogStats();
    stats.recordWarn("agent-a");
    stats.recordDuration("agent-a", 200);
    stats.recordDuration("agent-a", 400);

    const status = buildWatchdogStatus(new Map(), [], Date.now(), false, () => stats.snapshot());

    expect(status).toContain(
      "- byAgent agent=agent-a warns=1 resumes=0 aborts=0 durationCount=2 durationP50Ms=200 durationP95Ms=400 durationMaxMs=400",
    );
  });

  test("status output includes aggregate stats without tracked sessions", () => {
    const stats = new WatchdogStats();

    const status = buildWatchdogStatus(new Map(), [], Date.now(), false, () => stats.snapshot());

    expect(status).toContain("stream-watchdog: no tracked sessions.");
    expect(status).toContain("Aggregate stats:");
    expect(status).toContain("- totals warns=0 resumes=0 aborts=0");
  });
});
