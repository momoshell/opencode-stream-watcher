import type { Part } from "@opencode-ai/sdk";

import type {
  DurationConfig,
  LastPartKind,
  StallTransition,
  TrackedSession,
  WatchdogConfig,
} from "./types.js";

const RESUME_REARM_MS = 30_000;
const DEFAULT_NOOP_WATCHED_AGENTS = new Set<string>([
  "coder",
  "backend-specialist",
  "frontend-specialist",
  "devops-specialist",
  "test-engineer",
  "code-simplifier",
  "svelte-file-editor",
]);

export interface SessionMetadata {
  agent?: string;
  slug?: string;
}

export interface StartTrackingOptions {
  lastTurnMs?: number;
}

export function createTrackedSessions(): Map<string, TrackedSession> {
  return new Map<string, TrackedSession>();
}

export function startTracking(
  sessions: Map<string, TrackedSession>,
  sessionID: string,
  metadata: SessionMetadata = {},
  now = Date.now(),
  options: StartTrackingOptions = {},
): TrackedSession {
  const tracked: TrackedSession = {
    sessionID,
    agent: metadata.agent,
    slug: metadata.slug,
    callStart: now,
    lastActivity: now,
    mutated: false,
    endedWithBlocker: false,
    lastTurnMs: options.lastTurnMs,
    resumeStartedAt: undefined,
    state: "tracking",
    stateSince: now,
  };

  sessions.set(sessionID, tracked);
  return tracked;
}

export function resolveDurationConfig(
  tracked: TrackedSession,
  config: Pick<WatchdogConfig, "duration" | "perAgent">,
): DurationConfig {
  const agent = tracked.agent;
  if (agent === undefined) {
    return { ...config.duration };
  }

  const override = config.perAgent[agent]?.duration;
  return {
    enabled: config.duration.enabled,
    minToastMs: override?.minToastMs ?? config.duration.minToastMs,
    slowToastMs: override?.slowToastMs ?? config.duration.slowToastMs,
  };
}

export function resolveNoopWatch(
  tracked: TrackedSession,
  config: Pick<WatchdogConfig, "noop" | "perAgent">,
): boolean {
  if (!config.noop.enabled) {
    return false;
  }

  if (tracked.state === "aborted" || tracked.mutated || tracked.endedWithBlocker) {
    return false;
  }

  const agent = tracked.agent;
  if (agent === undefined) {
    return false;
  }

  if (!DEFAULT_NOOP_WATCHED_AGENTS.has(agent)) {
    return false;
  }

  const override = config.perAgent[agent]?.noopWatch;
  return override !== false;
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

  if (isCompletedEditToolPart(part)) {
    tracked.mutated = true;
  }

  if (part.type === "text" && typeof part.text === "string") {
    tracked.endedWithBlocker = part.text.trimStart().startsWith("BLOCKER:");
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
      if (shouldAbort(config.abortThresholdMs, idleMs)) {
        return transitionSession(tracked, "aborted", now, idleMs);
      }

      if (idleMs < config.warnThresholdMs) {
        return undefined;
      }

      return transitionSession(tracked, "warned", now, idleMs);

    case "warned":
      if (shouldAbort(config.abortThresholdMs, idleMs)) {
        return transitionSession(tracked, "aborted", now, idleMs);
      }

      if (shouldRearmTracking(tracked, config.warnThresholdMs, now, idleMs)) {
        return transitionSession(tracked, "tracking", now, idleMs);
      }

      return undefined;

    case "aborted":
      return undefined;
  }
}

function shouldAbort(abortThresholdMs: number, idleMs: number): boolean {
  return abortThresholdMs > 0 && idleMs >= abortThresholdMs;
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

export function snapshotTrackedSession(tracked: TrackedSession): TrackedSession {
  return {
    sessionID: tracked.sessionID,
    agent: tracked.agent,
    slug: tracked.slug,
    callStart: tracked.callStart,
    lastActivity: tracked.lastActivity,
    mutated: tracked.mutated,
    endedWithBlocker: tracked.endedWithBlocker,
    resumeStartedAt: tracked.resumeStartedAt,
    lastPartKind: tracked.lastPartKind,
    lastTurnMs: tracked.lastTurnMs,
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

function isCompletedEditToolPart(part: Part): boolean {
  return (
    part.type === "tool" &&
    isEditTool(part.tool) &&
    part.state.status === "completed"
  );
}

function isEditTool(tool: string): boolean {
  switch (tool) {
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
    case "svelte-file-editor":
    case "svelte_file_editor":
      return true;
    default:
      return false;
  }
}
