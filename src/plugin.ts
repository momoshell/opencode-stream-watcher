import type { Plugin } from "@opencode-ai/plugin";

import {
  createTrackedSessions,
  recordPartActivity,
  startTracking,
  stopTracking,
  type SessionMetadata,
  updateSessionMetadata,
} from "./state.js";
import type { TrackedSession } from "./types.js";

const SERVICE = "stream-watchdog";

export const StreamWatchdog: Plugin = async ({ client }) => {
  const trackedSessions = createTrackedSessions();

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
