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

export type WarnToastBody = {
  title: "⏸ Stream stalled";
  message: string;
  variant: "warning";
  duration: 0;
};

export type ResumeToastBody = {
  title: "▶ Stream recovered";
  message: string;
  variant: "success";
  duration: 4000;
};

export type AbortToastBody = {
  title: "🛑 Aborted stalled stream";
  message: string;
  variant: "error";
  duration: 8000;
};

export const UNKNOWN_LAST_PART_KIND = "unknown";
export const UNKNOWN_AGENT = "unknown";

export function toIdleSeconds(idleMs: number): number {
  return Math.max(0, Math.floor(idleMs / 1000));
}

export function normalizeLastPartKind(lastPartKind: string | null | undefined): string {
  if (!lastPartKind || lastPartKind.trim().length === 0) {
    return UNKNOWN_LAST_PART_KIND;
  }

  return lastPartKind;
}

export function normalizeAgent(agent: string | null | undefined): string {
  if (!agent || agent.trim().length === 0) {
    return UNKNOWN_AGENT;
  }

  return agent;
}

function normalizeSessionLabel(slug: string | null | undefined, sessionID: string): string {
  if (slug && slug.trim().length > 0) {
    return slug;
  }

  return sessionID;
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

export function buildWarnToastBody(args: {
  sessionID: string;
  slug: string | null | undefined;
  agent: string | null | undefined;
  idleMs: number;
  lastPartKind: string | null | undefined;
}): WarnToastBody {
  const resolvedAgent = normalizeAgent(args.agent);
  const sessionLabel = normalizeSessionLabel(args.slug, args.sessionID);

  return {
    title: "⏸ Stream stalled",
    message: `Agent: ${resolvedAgent}\nSession: ${sessionLabel}\nIdle: ${toIdleSeconds(args.idleMs)}s\nLast part: ${normalizeLastPartKind(args.lastPartKind)}\nEsc to interrupt · ask Huginn "kill ${resolvedAgent}" for selective abort`,
    variant: "warning",
    duration: 0,
  };
}

export function buildResumeToastBody(args: {
  sessionID: string;
  slug: string | null | undefined;
  agent: string | null | undefined;
  resumedAfterMs: number;
}): ResumeToastBody {
  const resolvedAgent = normalizeAgent(args.agent);
  const sessionLabel = normalizeSessionLabel(args.slug, args.sessionID);

  return {
    title: "▶ Stream recovered",
    message: `${resolvedAgent} · ${sessionLabel} · resumed after ${toIdleSeconds(args.resumedAfterMs)}s`,
    variant: "success",
    duration: 4000,
  };
}

export function buildAbortToastBody(args: {
  sessionID: string;
  slug: string | null | undefined;
  agent: string | null | undefined;
  idleMs: number;
}): AbortToastBody {
  const resolvedAgent = normalizeAgent(args.agent);
  const sessionLabel = normalizeSessionLabel(args.slug, args.sessionID);

  return {
    title: "🛑 Aborted stalled stream",
    message: `${resolvedAgent} · ${sessionLabel} · aborted after ${toIdleSeconds(args.idleMs)}s`,
    variant: "error",
    duration: 8000,
  };
}
