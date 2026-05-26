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

  await client.app.log({
    body: {
      service: SERVICE,
      level: "info",
      message: "loaded",
    },
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

          await client.app.log({
            body: {
              service: SERVICE,
              level: "debug",
              message: "tracking session",
              extra: {
                sessionID: tracked.sessionID,
                agent: tracked.agent,
                slug: tracked.slug,
              },
            },
          });
          return;
        }

        case "message.part.updated": {
          const tracked = recordPartActivity(
            trackedSessions,
            event.properties.part.sessionID,
            event.properties.part,
          );

          if (!tracked) {
            return;
          }

          await client.app.log({
            body: {
              service: SERVICE,
              level: "debug",
              message: "recorded session activity",
              extra: {
                sessionID: tracked.sessionID,
                lastActivity: tracked.lastActivity,
                lastPartKind: tracked.lastPartKind,
              },
            },
          });
          return;
        }

        case "session.idle": {
          await logStopTracking(
            client,
            event.properties.sessionID,
            stopTracking(trackedSessions, event.properties.sessionID),
            "session idle",
          );
          return;
        }

        case "session.error": {
          await logStopTracking(
            client,
            event.properties.sessionID,
            stopTracking(trackedSessions, event.properties.sessionID),
            "session error",
          );
          return;
        }

        case "session.deleted": {
          await logStopTracking(
            client,
            event.properties.info.id,
            stopTracking(trackedSessions, event.properties.info.id),
            "session deleted",
          );
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
    const tracked = updateSessionMetadata(trackedSessions, sessionID, metadata);

    if (!tracked) {
      return;
    }

    await client.app.log({
      body: {
        service: SERVICE,
        level: "debug",
        message: "updated session metadata",
        extra: {
          sessionID: tracked.sessionID,
          agent: tracked.agent,
          slug: tracked.slug,
        },
      },
    });
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
  } catch (error) {
    await client.app.log({
      body: {
        service: SERVICE,
        level: "debug",
        message: "session metadata unavailable",
        extra: {
          sessionID,
          error: getErrorMessage(error),
        },
      },
    });

    return {};
  }
}

async function logStopTracking(
  client: Parameters<Plugin>[0]["client"],
  sessionID: string | undefined,
  removed: boolean,
  reason: string,
): Promise<void> {
  await client.app.log({
    body: {
      service: SERVICE,
      level: "debug",
      message: "stopped tracking session",
      extra: {
        sessionID,
        removed,
        reason,
      },
    },
  });
}

async function logTickTransitions(
  client: PluginClient,
  transitions: StallTransition[],
): Promise<void> {
  for (const transition of transitions) {
    await client.app.log({
      body: {
        service: SERVICE,
        level: getTransitionLogLevel(transition),
        message: getTransitionMessage(transition),
        extra: {
          sessionID: transition.sessionID,
          from: transition.from,
          to: transition.to,
          at: transition.at,
          idleMs: transition.idleMs,
          agent: transition.tracked.agent,
          slug: transition.tracked.slug,
          lastPartKind: transition.tracked.lastPartKind,
          state: transition.tracked.state,
          stateSince: transition.tracked.stateSince,
          lastActivity: transition.tracked.lastActivity,
        },
      },
    });
  }
}

function getTransitionLogLevel(
  transition: StallTransition,
): "debug" | "warn" {
  return transition.to === "tracking" ? "debug" : "warn";
}

function getTransitionMessage(transition: StallTransition): string {
  switch (transition.to) {
    case "warned":
      return "session stall warning";
    case "tracking":
      return "session stall cleared";
    case "aborted":
      return "session stall abort threshold reached";
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
