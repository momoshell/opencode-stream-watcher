import { describe, expect, test } from "bun:test";

import { buildIncidentLogEntry, buildWarnToastBody } from "../dist/notify.js";

describe("notify buildIncidentLogEntry", () => {
  test("maps tracking-start and RESUME to info", () => {
    const trackingStart = buildIncidentLogEntry({
      stage: "tracking-start",
      sessionID: "s-1",
      agent: "agent-a",
      idleMs: 0,
      lastPartKind: undefined,
    });

    const resume = buildIncidentLogEntry({
      stage: "RESUME",
      sessionID: "s-2",
      agent: "agent-b",
      idleMs: 31_001,
      lastPartKind: "text",
    });

    expect(trackingStart.service).toBe("stream-watchdog");
    expect(trackingStart.level).toBe("info");
    expect(trackingStart.message).toBe("tracking-start");
    expect(trackingStart.extra).toEqual({
      sessionID: "s-1",
      agent: "agent-a",
      idleSeconds: 0,
      lastPartKind: "unknown",
    });

    expect(resume.level).toBe("info");
    expect(resume.message).toBe("RESUME");
    expect(resume.extra).toEqual({
      sessionID: "s-2",
      agent: "agent-b",
      idleSeconds: 31,
      lastPartKind: "text",
    });
  });

  test("maps WARN and ABORT to warn", () => {
    const warn = buildIncidentLogEntry({
      stage: "WARN",
      sessionID: "s-3",
      agent: "agent-c",
      idleMs: 90_000,
      lastPartKind: "",
    });

    const abort = buildIncidentLogEntry({
      stage: "ABORT",
      sessionID: "s-4",
      agent: "agent-d",
      idleMs: 180_000,
      lastPartKind: "tool",
    });

    expect(warn.level).toBe("warn");
    expect(warn.message).toBe("WARN");
    expect(warn.extra).toEqual({
      sessionID: "s-3",
      agent: "agent-c",
      idleSeconds: 90,
      lastPartKind: "unknown",
    });

    expect(abort.level).toBe("warn");
    expect(abort.message).toBe("ABORT");
    expect(abort.extra).toEqual({
      sessionID: "s-4",
      agent: "agent-d",
      idleSeconds: 180,
      lastPartKind: "tool",
    });
  });
});
describe("buildWarnToastBody", () => {
  test("builds warning toast payload and exact message", () => {
    expect(
      buildWarnToastBody({
        sessionID: "session-123",
        slug: "agent-x-run",
        agent: "agent-x",
        idleMs: 93_000,
        lastPartKind: "assistant",
      }),
    ).toEqual({
      variant: "warning",
      title: "⏸ Stream stalled",
      message:
        'Agent: agent-x\nSession: agent-x-run\nIdle: 93s\nLast part: assistant\nEsc to interrupt · ask Huginn "kill agent-x" for selective abort',
      duration: 0,
    });
  });

  test("falls back to unknown agent and session id slug", () => {
    expect(
      buildWarnToastBody({
        sessionID: "session-abc",
        slug: "",
        agent: "",
        idleMs: 12_900,
        lastPartKind: "",
      }),
    ).toEqual({
      variant: "warning",
      title: "⏸ Stream stalled",
      message:
        'Agent: unknown\nSession: session-abc\nIdle: 12s\nLast part: unknown\nEsc to interrupt · ask Huginn "kill unknown" for selective abort',
      duration: 0,
    });
  });
});
