import { tool } from "@opencode-ai/plugin";

import { formatWatchdogStats, type WatchdogStatsSnapshot } from "./stats.js";

import type {
  LastPartKind,
  RecentWatchdogEvent,
  StallTransition,
  TrackedSession,
  WatchdogAbortResult,
  WatchdogEventType,
} from "./types.js";

const MAX_RECENT_EVENTS = 10;

interface WatchdogStatusToolInput {
  trackedSessions: ReadonlyMap<string, TrackedSession>;
  recentEvents: readonly RecentWatchdogEvent[];
  getStatsSnapshot?: () => WatchdogStatsSnapshot;
}

interface WatchdogAbortToolInput {
  trackedSessions: ReadonlyMap<string, TrackedSession>;
  abortSession: (sessionID: string) => Promise<boolean>;
  logAbort?: (entry: WatchdogAbortLogEntry) => Promise<void>;
  now?: () => number;
}

interface WatchdogAbortArgs {
  sessionID?: string;
}

export interface WatchdogAbortLogEntry {
  result: WatchdogAbortResult;
  lastPartKind?: LastPartKind;
}

interface WatchdogAbortTarget {
  sessionID: string;
  agent?: string;
  idleMs: number;
  lastPartKind?: LastPartKind;
}

export function createWatchdogStatusTool(input: WatchdogStatusToolInput) {
  return tool({
    description: "Report stream watchdog tracking state and recent stall transitions.",
    args: {
      verbose: tool.schema.boolean().optional().describe("Include timestamp details for tracked sessions."),
    },
    async execute(args) {
      return buildWatchdogStatus(
        input.trackedSessions,
        input.recentEvents,
        Date.now(),
        args.verbose ?? false,
        input.getStatsSnapshot,
      );
    },
  });
}

export function createWatchdogAbortTool(input: WatchdogAbortToolInput) {
  return tool({
    description: "Abort a tracked stream watchdog session, or the longest-idle tracked session when omitted.",
    args: {
      sessionID: tool.schema.string().optional().describe("Specific opencode session ID to abort."),
    },
    async execute(args, context) {
      const result = await executeWatchdogAbort(input, args);
      context.metadata({ metadata: toAbortMetadata(result) });

      return JSON.stringify(result);
    },
  });
}

export async function executeWatchdogAbort(
  input: WatchdogAbortToolInput,
  args: WatchdogAbortArgs,
): Promise<WatchdogAbortResult> {
  const target = resolveAbortTarget(
    input.trackedSessions,
    args.sessionID,
    input.now?.() ?? Date.now(),
  );

  if (!target) {
    return {
      aborted: false,
      sessionID: "",
      idleMs: 0,
    };
  }

  const aborted = await tryAbortSession(input.abortSession, target.sessionID);
  const result = toAbortResult(target, aborted);

  if (aborted) {
    await tryLogAbort(input.logAbort, { result, lastPartKind: target.lastPartKind });
  }

  return result;
}

export function recordRecentWatchdogTransitions(
  recentEvents: RecentWatchdogEvent[],
  transitions: readonly StallTransition[],
): void {
  for (const transition of transitions) {
    recentEvents.push({
      time: transition.at,
      type: toWatchdogEventType(transition),
      sessionID: transition.sessionID,
      agent: transition.tracked.agent ?? "unknown",
    });
  }

  while (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.shift();
  }
}

export function buildWatchdogStatus(
  trackedSessions: ReadonlyMap<string, TrackedSession>,
  recentEvents: readonly RecentWatchdogEvent[],
  now: number,
  verbose: boolean,
  getStatsSnapshot?: () => WatchdogStatsSnapshot,
): string {
  const tracked = [...trackedSessions.values()].sort((left, right) => left.sessionID.localeCompare(right.sessionID));
  const lines: string[] = [];

  if (tracked.length === 0) {
    lines.push("stream-watchdog: no tracked sessions.");
  } else {
    lines.push(`stream-watchdog: tracking ${tracked.length} session${tracked.length === 1 ? "" : "s"}.`);
    lines.push("Tracked sessions:");

    for (const session of tracked) {
      lines.push(formatTrackedSession(session, now, verbose));
    }
  }

  lines.push(...formatRecentEvents(recentEvents));

  if (getStatsSnapshot) {
    lines.push(...formatWatchdogStats(getStatsSnapshot()));
  }

  return lines.join("\n");
}

function resolveAbortTarget(
  trackedSessions: ReadonlyMap<string, TrackedSession>,
  requestedSessionID: string | undefined,
  now: number,
): WatchdogAbortTarget | undefined {
  if (requestedSessionID !== undefined) {
    const tracked = trackedSessions.get(requestedSessionID);

    if (!tracked) {
      return {
        sessionID: requestedSessionID,
        idleMs: 0,
      };
    }

    return toAbortTarget(tracked, now);
  }

  const tracked = selectLongestIdleTrackedSession(trackedSessions);
  return tracked ? toAbortTarget(tracked, now) : undefined;
}

function selectLongestIdleTrackedSession(
  trackedSessions: ReadonlyMap<string, TrackedSession>,
): TrackedSession | undefined {
  let selected: TrackedSession | undefined;

  for (const tracked of trackedSessions.values()) {
    if (!selected) {
      selected = tracked;
      continue;
    }

    if (tracked.lastActivity < selected.lastActivity) {
      selected = tracked;
      continue;
    }

    if (
      tracked.lastActivity === selected.lastActivity &&
      tracked.sessionID.localeCompare(selected.sessionID) < 0
    ) {
      selected = tracked;
    }
  }

  return selected;
}

function toAbortTarget(tracked: TrackedSession, now: number): WatchdogAbortTarget {
  return {
    sessionID: tracked.sessionID,
    agent: tracked.agent,
    idleMs: Math.max(0, now - tracked.lastActivity),
    lastPartKind: tracked.lastPartKind,
  };
}

async function tryAbortSession(
  abortSession: (sessionID: string) => Promise<boolean>,
  sessionID: string,
): Promise<boolean> {
  try {
    return await abortSession(sessionID);
  } catch {
    return false;
  }
}

async function tryLogAbort(
  logAbort: ((entry: WatchdogAbortLogEntry) => Promise<void>) | undefined,
  entry: WatchdogAbortLogEntry,
): Promise<void> {
  if (!logAbort) {
    return;
  }

  try {
    await logAbort(entry);
  } catch {
    // Logging is best-effort and must never interrupt tool behavior.
  }
}

function toAbortResult(target: WatchdogAbortTarget, aborted: boolean): WatchdogAbortResult {
  return {
    aborted,
    sessionID: target.sessionID,
    agent: target.agent,
    idleMs: target.idleMs,
  };
}

function toAbortMetadata(result: WatchdogAbortResult): Record<string, boolean | number | string> {
  const metadata: Record<string, boolean | number | string> = {
    aborted: result.aborted,
    sessionID: result.sessionID,
    idleMs: result.idleMs,
  };

  if (result.agent !== undefined) {
    metadata.agent = result.agent;
  }

  return metadata;
}

function formatTrackedSession(session: TrackedSession, now: number, verbose: boolean): string {
  const parts = [
    `sessionID=${session.sessionID}`,
    `agent=${session.agent ?? "unknown"}`,
    `slug=${session.slug ?? "unknown"}`,
    `idleMs=${Math.max(0, now - session.lastActivity)}`,
    `lastPartKind=${session.lastPartKind ?? "unknown"}`,
    `state=${session.state}`,
  ];

  if (session.lastTurnMs !== undefined) {
    parts.push(`lastTurnMs=${session.lastTurnMs}`);
  }

  if (verbose) {
    parts.push(
      `lastActivity=${new Date(session.lastActivity).toISOString()}`,
      `stateSince=${new Date(session.stateSince).toISOString()}`,
    );
  }

  return `- ${parts.join(" ")}`;
}

function formatRecentEvents(recentEvents: readonly RecentWatchdogEvent[]): string[] {
  if (recentEvents.length === 0) {
    return ["Recent events: none."];
  }

  return [
    "Recent events (oldest → newest):",
    ...recentEvents.map((event) => (
      `- time=${new Date(event.time).toISOString()} type=${event.type} sessionID=${event.sessionID} agent=${event.agent}`
    )),
  ];
}

function toWatchdogEventType(transition: StallTransition): WatchdogEventType {
  switch (transition.to) {
    case "warned":
      return "WARN";
    case "tracking":
      return "RESUME";
    case "aborted":
      return "ABORT";
  }
}
