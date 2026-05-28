import { tool } from "@opencode-ai/plugin";

import type {
  RecentWatchdogEvent,
  StallTransition,
  TrackedSession,
  WatchdogEventType,
} from "./types.js";

const MAX_RECENT_EVENTS = 10;

interface WatchdogStatusToolInput {
  trackedSessions: ReadonlyMap<string, TrackedSession>;
  recentEvents: readonly RecentWatchdogEvent[];
}

export function createWatchdogStatusTool(input: WatchdogStatusToolInput) {
  return tool({
    description: "Report stream watchdog tracking state and recent stall transitions.",
    args: {
      verbose: tool.schema.boolean().optional().describe("Include timestamp details for tracked sessions."),
    },
    async execute(args) {
      return buildWatchdogStatus(input.trackedSessions, input.recentEvents, Date.now(), args.verbose ?? false);
    },
  });
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

function buildWatchdogStatus(
  trackedSessions: ReadonlyMap<string, TrackedSession>,
  recentEvents: readonly RecentWatchdogEvent[],
  now: number,
  verbose: boolean,
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
  return lines.join("\n");
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
