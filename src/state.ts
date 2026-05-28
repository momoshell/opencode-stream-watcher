import type { Part } from "@opencode-ai/sdk";

import type {
  LastPartKind,
  StallTransition,
  TrackedSession,
  WatchdogConfig,
} from "./types.js";

const RESUME_REARM_MS = 30_000;

export interface SessionMetadata {
  agent?: string;
  slug?: string;
}

export function createTrackedSessions(): Map<string, TrackedSession> {
  return new Map<string, TrackedSession>();
}

export function startTracking(
  sessions: Map<string, TrackedSession>,
  sessionID: string,
  metadata: SessionMetadata = {},
  now = Date.now(),
): TrackedSession {
  const tracked: TrackedSession = {
    sessionID,
    agent: metadata.agent,
    slug: metadata.slug,
    lastActivity: now,
    resumeStartedAt: undefined,
    state: "tracking",
    stateSince: now,
  };

  sessions.set(sessionID, tracked);
  return tracked;
}

export function recordPartActivity(
  sessions: Map<string, TrackedSession>,
  sessionID: string,
  part: Part,
  now = Date.now(),
): TrackedSession | undefined {
  const tracked = sessions.get(sessionID);

  if (!tracked) {
    return undefined;
  }

  tracked.lastActivity = now;

  if (
    tracked.state === "warned" &&
    tracked.resumeStartedAt === undefined &&
    now > tracked.stateSince
  ) {
    tracked.resumeStartedAt = now;
  }

  const partKind = getTrackedPartKind(part);
  if (partKind) {
    tracked.lastPartKind = partKind;
  }

  return tracked;
}

export function updateSessionMetadata(
  sessions: Map<string, TrackedSession>,
  sessionID: string,
  metadata: SessionMetadata,
): TrackedSession | undefined {
  const tracked = sessions.get(sessionID);

  if (!tracked) {
    return undefined;
  }

  if (metadata.agent) {
    tracked.agent = metadata.agent;
  }

  if (metadata.slug) {
    tracked.slug = metadata.slug;
  }

  return tracked;
}

export function stopTracking(
  sessions: Map<string, TrackedSession>,
  sessionID: string | undefined,
): boolean {
  if (!sessionID) {
    return false;
  }

  return sessions.delete(sessionID);
}

export function scanTrackedSessions(
  sessions: Map<string, TrackedSession>,
  config: Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs" | "perAgent">,
  now = Date.now(),
): StallTransition[] {
  const transitions: StallTransition[] = [];

  for (const tracked of sessions.values()) {
    const transition = scanTrackedSession(tracked, resolveThresholds(tracked, config), now);
    if (transition) {
      transitions.push(transition);
    }
  }

  return transitions;
}

function scanTrackedSession(
  tracked: TrackedSession,
  config: Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs">,
  now: number,
): StallTransition | undefined {
  const idleMs = getIdleMs(tracked, now);

  switch (tracked.state) {
    case "tracking":
      if (idleMs < config.warnThresholdMs) {
        return undefined;
      }

      return transitionSession(tracked, "warned", now, idleMs);

    case "warned":
      if (shouldRearmTracking(tracked, config.warnThresholdMs, now, idleMs)) {
        return transitionSession(tracked, "tracking", now, idleMs);
      }

      if (config.abortThresholdMs <= 0) {
        return undefined;
      }

      if (idleMs < config.abortThresholdMs) {
        return undefined;
      }

      return transitionSession(tracked, "aborted", now, idleMs);

    case "aborted":
      return undefined;
  }
}

function resolveThresholds(
  tracked: TrackedSession,
  config: Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs" | "perAgent">,
): Pick<WatchdogConfig, "warnThresholdMs" | "abortThresholdMs"> {
  const agent = tracked.agent;
  if (agent === undefined) {
    return {
      warnThresholdMs: config.warnThresholdMs,
      abortThresholdMs: config.abortThresholdMs,
    };
  }

  const override = config.perAgent[agent];
  return {
    warnThresholdMs: override?.warnThresholdMs ?? config.warnThresholdMs,
    abortThresholdMs: override?.abortThresholdMs ?? config.abortThresholdMs,
  };
}

function shouldRearmTracking(
  tracked: TrackedSession,
  warnThresholdMs: number,
  now: number,
  idleMs: number,
): boolean {
  if (
    tracked.resumeStartedAt === undefined ||
    tracked.resumeStartedAt <= tracked.stateSince
  ) {
    return false;
  }

  if (now - tracked.resumeStartedAt <= RESUME_REARM_MS) {
    return false;
  }

  return idleMs < warnThresholdMs;
}

function transitionSession(
  tracked: TrackedSession,
  to: TrackedSession["state"],
  now: number,
  idleMs: number,
): StallTransition {
  const from = tracked.state;
  tracked.state = to;
  tracked.stateSince = now;
  tracked.resumeStartedAt = undefined;

  return {
    sessionID: tracked.sessionID,
    from,
    to,
    at: now,
    idleMs,
    tracked: snapshotTrackedSession(tracked),
  };
}

function getIdleMs(tracked: TrackedSession, now: number): number {
  return Math.max(0, now - tracked.lastActivity);
}

function snapshotTrackedSession(tracked: TrackedSession): TrackedSession {
  return {
    sessionID: tracked.sessionID,
    agent: tracked.agent,
    slug: tracked.slug,
    lastActivity: tracked.lastActivity,
    resumeStartedAt: tracked.resumeStartedAt,
    lastPartKind: tracked.lastPartKind,
    state: tracked.state,
    stateSince: tracked.stateSince,
  };
}

function getTrackedPartKind(part: Part): LastPartKind | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
    case "tool":
      return part.type;
    default:
      return undefined;
  }
}
