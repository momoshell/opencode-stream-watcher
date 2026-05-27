export type IncidentStage = "tracking-start" | "WARN" | "RESUME" | "ABORT";

export type IncidentLevel = "info" | "warn";

export type IncidentLogEntry = {
  service: "stream-watchdog";
  level: IncidentLevel;
  message: IncidentStage;
  extra: {
    sessionID: string;
    agent: string;
    idleSeconds: number;
    lastPartKind: string;
  };
};

export const UNKNOWN_LAST_PART_KIND = "unknown";

export function toIdleSeconds(idleMs: number): number {
  return Math.max(0, Math.floor(idleMs / 1000));
}

export function normalizeLastPartKind(lastPartKind: string | null | undefined): string {
  if (!lastPartKind || lastPartKind.trim().length === 0) {
    return UNKNOWN_LAST_PART_KIND;
  }

  return lastPartKind;
}

export function incidentLevelFor(stage: IncidentStage): IncidentLevel {
  return stage === "WARN" || stage === "ABORT" ? "warn" : "info";
}

export function buildIncidentLogEntry(args: {
  stage: IncidentStage;
  sessionID: string;
  agent: string;
  idleMs: number;
  lastPartKind: string | null | undefined;
}): IncidentLogEntry {
  return {
    service: "stream-watchdog",
    level: incidentLevelFor(args.stage),
    message: args.stage,
    extra: {
      sessionID: args.sessionID,
      agent: args.agent,
      idleSeconds: toIdleSeconds(args.idleMs),
      lastPartKind: normalizeLastPartKind(args.lastPartKind),
    },
  };
}
