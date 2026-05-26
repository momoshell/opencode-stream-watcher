import type { Part } from "@opencode-ai/sdk";

import type { LastPartKind, TrackedSession } from "./types.js";

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
    state: "tracking",
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
