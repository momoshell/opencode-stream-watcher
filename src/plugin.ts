import type { Plugin } from "@opencode-ai/plugin";

import { loadWatchdogConfig, type ConfigLogger } from "./config.js";
import {
  createTrackedSessions,
  recordPartActivity,
  resolveDurationConfig,
  scanTrackedSessions,
  startTracking,
  stopTracking,
  type SessionMetadata,
  updateSessionMetadata,
} from "./state.js";
import {
  buildAbortToastBody,
  buildIncidentLogEntry,
  buildResumeToastBody,
  buildTurnDurationLogEntry,
  buildTurnDurationToastBody,
  buildWarnToastBody,
  normalizeAgent,
  type IncidentStage,
} from "./notify.js";
import {
  createWatchdogAbortTool,
  createWatchdogStatusTool,
  recordRecentWatchdogTransitions,
} from "./tools.js";
import { WatchdogStats } from "./stats.js";
import type {
  RecentWatchdogEvent,
  StallTransition,
  TrackedSession,
  WatchdogConfig,
} from "./types.js";

const SERVICE = "stream-watchdog";
type PluginClient = Parameters<Plugin>[0]["client"];

type ActiveTickLoop = {
  interval: ReturnType<typeof globalThis.setInterval>;
};

let activeTickLoop: ActiveTickLoop | undefined;

export const StreamWatchdog: Plugin = async ({ project, client, directory, worktree }) => {
  const trackedSessions = createTrackedSessions();
  const lastTurnMsBySession = new Map<string, number>();
  const recentEvents: RecentWatchdogEvent[] = [];
  const stats = new WatchdogStats();
  const config = await loadWatchdogConfig({
    projectRoot: deriveProjectRoot(project, directory, worktree),
    logger: createConfigLogger(client),
  });

  startTickLoop(client, trackedSessions, recentEvents, stats, config);

  await safeLog(client, {
    service: SERVICE,
    level: "info",
    message: "loaded",
  });

  return {
    tool: {
      watchdog_abort: createWatchdogAbortTool({
        trackedSessions,
        abortSession: (sessionID) => abortSession(client, sessionID),
        logAbort: async ({ result, lastPartKind }) => {
          stats.recordAbort(result.agent);
          await safeLog(client, buildIncidentLogEntry({
            stage: "ABORT",
            sessionID: result.sessionID,
            agent: normalizeAgent(result.agent),
            idleMs: result.idleMs,
            lastPartKind,
          }));
        },
      }),
      watchdog_status: createWatchdogStatusTool({
        trackedSessions,
        recentEvents,
        getStatsSnapshot: () => stats.snapshot(),
      }),
    },
    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          if (event.properties.status.type !== "busy") {
            return;
          }

          const sessionID = event.properties.sessionID;
          const tracked = startTracking(trackedSessions, sessionID, {}, Date.now(), {
            lastTurnMs: lastTurnMsBySession.get(sessionID),
          });
          void enrichSessionMetadata(client, trackedSessions, sessionID);

          await safeLog(client, buildIncidentLogEntry({
            stage: "tracking-start",
            sessionID: tracked.sessionID,
            agent: tracked.agent ?? "unknown",
            idleMs: 0,
            lastPartKind: tracked.lastPartKind,
          }));
          return;
        }

        case "message.part.updated": {
          const sessionID = event.properties.part.sessionID;
          const previousState = trackedSessions.get(sessionID)?.state;
          const previousResumeStartedAt = trackedSessions.get(sessionID)?.resumeStartedAt;
          const tracked = recordPartActivity(
            trackedSessions,
            sessionID,
            event.properties.part,
          );

          if (
            tracked &&
            previousState === "warned" &&
            previousResumeStartedAt === undefined
          ) {
            const resumeStartedAt = tracked.resumeStartedAt ?? Math.max(Date.now(), tracked.stateSince + 1);

            if (tracked.resumeStartedAt === undefined) {
              tracked.resumeStartedAt = resumeStartedAt;
            }

            if (tracked.state === "warned") {
              stats.recordResume(tracked.agent);
            }

            if (config.toast && tracked.state === "warned") {
              await safeToast(client, buildResumeToastBody({
                sessionID: tracked.sessionID,
                slug: tracked.slug,
                agent: tracked.agent,
                resumedAfterMs: Math.max(0, resumeStartedAt - tracked.stateSince),
              }));
            }
          }

          return;
        }

        case "session.idle": {
          await handleSessionIdle(
            client,
            trackedSessions,
            lastTurnMsBySession,
            stats,
            event.properties.sessionID,
            config,
          );
          return;
        }

        case "session.error": {
          stopTracking(trackedSessions, event.properties.sessionID);
          return;
        }

        case "session.deleted": {
          const sessionID = event.properties.info.id;
          stopTracking(trackedSessions, sessionID);
          lastTurnMsBySession.delete(sessionID);
          return;
        }

        default:
          return;
      }
    },
  };
};

function deriveProjectRoot(project: unknown, directory: unknown, worktree: unknown): string {
  if (isNonEmptyString(worktree)) {
    return worktree;
  }

  const projectRoot = readProjectRoot(project);
  if (projectRoot) {
    return projectRoot;
  }

  if (isNonEmptyString(directory)) {
    return directory;
  }

  return process.cwd();
}

async function handleSessionIdle(
  client: PluginClient,
  trackedSessions: Map<string, TrackedSession>,
  lastTurnMsBySession: Map<string, number>,
  stats: WatchdogStats,
  sessionID: string | undefined,
  config: Pick<WatchdogConfig, "duration" | "log" | "toast" | "perAgent">,
): Promise<void> {
  if (!sessionID) {
    return;
  }

  const tracked = trackedSessions.get(sessionID);
  if (!tracked) {
    stopTracking(trackedSessions, sessionID);
    return;
  }

  const durationMs = Math.max(0, Date.now() - tracked.callStart);
  tracked.lastTurnMs = durationMs;
  lastTurnMsBySession.set(sessionID, durationMs);
  stats.recordDuration(tracked.agent, durationMs);

  const durationConfig = resolveDurationConfig(tracked, config);
  if (durationConfig.enabled) {
    if (config.log) {
      await safeLog(client, buildTurnDurationLogEntry({
        sessionID: tracked.sessionID,
        agent: tracked.agent,
        durationMs,
      }));
    }

    if (config.toast && durationMs >= durationConfig.minToastMs) {
      await safeToast(client, buildTurnDurationToastBody({
        agent: tracked.agent,
        durationMs,
        slow: durationMs >= durationConfig.slowToastMs,
      }));
    }
  }

  stopTracking(trackedSessions, sessionID);
}

function readProjectRoot(project: unknown): string | undefined {
  if (isNonEmptyString(project)) {
    return project;
  }

  if (!isRecord(project)) {
    return undefined;
  }

  const path = getOptionalString(project["path"]);
  if (isNonEmptyString(path)) {
    return path;
  }

  const root = getOptionalString(project["root"]);
  if (isNonEmptyString(root)) {
    return root;
  }

  const directory = getOptionalString(project["directory"]);
  if (isNonEmptyString(directory)) {
    return directory;
  }

  return undefined;
}

function createConfigLogger(client: PluginClient): ConfigLogger {
  return (message, level = "warn") => {
    const resolvedLevel = level === "error" ? "warn" : level;

    void safeLog(client, {
      service: SERVICE,
      level: resolvedLevel,
      message,
    });
  };
}

function startTickLoop(
  client: PluginClient,
  trackedSessions: Map<string, TrackedSession>,
  recentEvents: RecentWatchdogEvent[],
  stats: WatchdogStats,
  config: Pick<
    WatchdogConfig,
    "tickMs" | "warnThresholdMs" | "abortThresholdMs" | "log" | "toast" | "perAgent"
  >,
): void {
  stopTickLoop();

  const interval = globalThis.setInterval(() => {
    const transitions = scanTrackedSessions(trackedSessions, config);

    if (transitions.length === 0) {
      return;
    }

    recordRecentWatchdogTransitions(recentEvents, transitions);
    recordWarnStats(stats, transitions);

    void emitTickTransitions(client, transitions, stats, config).catch(() => undefined);
  }, config.tickMs);

  activeTickLoop = { interval };
  maybeUnrefTimer(interval);
}

function stopTickLoop(): void {
  const interval = activeTickLoop?.interval;

  if (!interval) {
    return;
  }

  globalThis.clearInterval(interval);
  activeTickLoop = undefined;
}

async function enrichSessionMetadata(
  client: Parameters<Plugin>[0]["client"],
  trackedSessions: Map<string, TrackedSession>,
  sessionID: string,
): Promise<void> {
  try {
    const metadata = await getSessionMetadata(client, sessionID);
    updateSessionMetadata(trackedSessions, sessionID, metadata);
  } catch {
    // Metadata is best-effort and must never interrupt activity tracking.
  }
}

async function getSessionMetadata(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string,
): Promise<SessionMetadata> {
  try {
    const response = await client.session.get({ path: { id: sessionID } });
    return readSessionMetadata(response.data);
  } catch {
    return {};
  }
}

async function emitTickTransitions(
  client: PluginClient,
  transitions: StallTransition[],
  stats: WatchdogStats,
  config: Pick<WatchdogConfig, "log" | "toast">,
): Promise<void> {
  for (const transition of transitions) {
    if (transition.to === "aborted") {
      const aborted = await abortSession(client, transition.sessionID);
      if (!aborted) {
        continue;
      }

      stats.recordAbort(transition.tracked.agent);
    }

    if (config.log) {
      await safeLog(client, buildIncidentLogEntry({
        stage: toIncidentStage(transition),
        sessionID: transition.sessionID,
        agent: normalizeAgent(transition.tracked.agent),
        idleMs: transition.idleMs,
        lastPartKind: transition.tracked.lastPartKind,
      }));
    }

    if (config.toast && transition.to === "warned") {
      await safeToast(client, buildWarnToastBody({
        sessionID: transition.sessionID,
        slug: transition.tracked.slug,
        agent: transition.tracked.agent,
        idleMs: transition.idleMs,
        lastPartKind: transition.tracked.lastPartKind,
      }));
    }

    if (config.toast && transition.to === "aborted") {
      await safeToast(client, buildAbortToastBody({
        sessionID: transition.sessionID,
        slug: transition.tracked.slug,
        agent: transition.tracked.agent,
        idleMs: transition.idleMs,
      }));
    }
  }
}

function recordWarnStats(stats: WatchdogStats, transitions: readonly StallTransition[]): void {
  for (const transition of transitions) {
    if (transition.to === "warned") {
      stats.recordWarn(transition.tracked.agent);
    }
  }
}

async function abortSession(client: PluginClient, sessionID: string): Promise<boolean> {
  try {
    const response = await client.session.abort({ path: { id: sessionID } });
    return response.data === true;
  } catch {
    return false;
  }
}

function toIncidentStage(transition: StallTransition): IncidentStage {
  switch (transition.to) {
    case "warned":
      return "WARN";
    case "tracking":
      return "RESUME";
    case "aborted":
      return "ABORT";
  }
}

async function safeLog(
  client: PluginClient,
  body: {
    service: "stream-watchdog";
    level: "info" | "warn";
    message: string;
    extra?: Record<string, string | number>;
  },
): Promise<void> {
  try {
    await client.app.log({ body });
  } catch {
    // Logging is best-effort and must never interrupt plugin behavior.
  }
}

async function safeToast(
  client: PluginClient,
  body: {
    title?: string;
    message: string;
    variant: "info" | "warning" | "success" | "error";
    duration?: number;
  },
): Promise<void> {
  try {
    await client.tui.showToast({ body });
  } catch {
    // Toasts are best-effort and must never interrupt plugin behavior.
  }
}

type TimerWithUnref = {
  unref: () => void;
};

function maybeUnrefTimer(timer: ReturnType<typeof globalThis.setInterval>): void {
  if (hasUnref(timer)) {
    timer.unref();
  }
}

function hasUnref(value: unknown): value is TimerWithUnref {
  return (
    typeof value === "object" &&
    value !== null &&
    "unref" in value &&
    typeof value.unref === "function"
  );
}

function readSessionMetadata(session: unknown): SessionMetadata {
  if (!isRecord(session)) {
    return {};
  }

  return {
    agent: getOptionalString(session["agent"]),
    slug: getOptionalString(session["slug"]),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
