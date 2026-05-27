import type { Plugin } from "@opencode-ai/plugin";

import {
  createTrackedSessions,
  recordPartActivity,
  scanTrackedSessions,
  startTracking,
  stopTracking,
  type SessionMetadata,
  updateSessionMetadata,
} from "./state.js";
import { buildIncidentLogEntry, type IncidentStage } from "./notify.js";
import type { StallTransition, TrackedSession, WatchdogConfig } from "./types.js";

const SERVICE = "stream-watchdog";
type PluginClient = Parameters<Plugin>[0]["client"];
const DEFAULT_TICK_LOOP_CONFIG = {
  warnThresholdMs: 90_000,
  abortThresholdMs: 0,
  tickMs: 10_000,
  log: true,
} satisfies Pick<WatchdogConfig, "tickMs" | "warnThresholdMs" | "abortThresholdMs" | "log">;

type ActiveTickLoop = {
  interval: ReturnType<typeof globalThis.setInterval>;
};

let activeTickLoop: ActiveTickLoop | undefined;

export const StreamWatchdog: Plugin = async ({ client }) => {
  const trackedSessions = createTrackedSessions();
  startTickLoop(client, trackedSessions, DEFAULT_TICK_LOOP_CONFIG);

  await safeLog(client, {
    service: SERVICE,
    level: "info",
    message: "loaded",
  });

  return {
    event: async ({ event }) => {
      switch (event.type) {
        case "session.status": {
          if (event.properties.status.type !== "busy") {
            return;
          }

          const sessionID = event.properties.sessionID;
          const tracked = startTracking(trackedSessions, sessionID);
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
          recordPartActivity(
            trackedSessions,
            event.properties.part.sessionID,
            event.properties.part,
          );
          return;
        }

        case "session.idle": {
          stopTracking(trackedSessions, event.properties.sessionID);
          return;
        }

        case "session.error": {
          stopTracking(trackedSessions, event.properties.sessionID);
          return;
        }

        case "session.deleted": {
          stopTracking(trackedSessions, event.properties.info.id);
          return;
        }

        default:
          return;
      }
    },
  };
};

function startTickLoop(
  client: PluginClient,
  trackedSessions: Map<string, TrackedSession>,
  config: Pick<WatchdogConfig, "tickMs" | "warnThresholdMs" | "abortThresholdMs" | "log">,
): void {
  stopTickLoop();

  const interval = globalThis.setInterval(() => {
    const transitions = scanTrackedSessions(trackedSessions, config);

    if (!config.log || transitions.length === 0) {
      return;
    }

    void logTickTransitions(client, transitions).catch(() => undefined);
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

async function logTickTransitions(
  client: PluginClient,
  transitions: StallTransition[],
): Promise<void> {
  for (const transition of transitions) {
    await safeLog(client, buildIncidentLogEntry({
      stage: toIncidentStage(transition),
      sessionID: transition.sessionID,
      agent: transition.tracked.agent ?? "unknown",
      idleMs: transition.idleMs,
      lastPartKind: transition.tracked.lastPartKind,
    }));
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
