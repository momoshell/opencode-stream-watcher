export type StallState = "tracking" | "warned" | "aborted";

export type LastPartKind = "text" | "reasoning" | "tool";

export interface PerAgentThresholdConfig {
  warnThresholdMs?: number;
  abortThresholdMs?: number;
  duration?: PerAgentDurationConfig;
}

export interface DurationConfig {
  enabled: boolean;
  minToastMs: number;
  slowToastMs: number;
}

export type PerAgentDurationConfig = Partial<Pick<DurationConfig, "minToastMs" | "slowToastMs">>;

export interface WatchdogConfig {
  warnThresholdMs: number;
  abortThresholdMs: number;
  tickMs: number;
  toast: boolean;
  log: boolean;
  duration: DurationConfig;
  perAgent: Record<string, PerAgentThresholdConfig>;
}

export interface TrackedSession {
  sessionID: string;
  agent?: string;
  slug?: string;
  callStart: number;
  lastActivity: number;
  resumeStartedAt?: number;
  lastPartKind?: LastPartKind;
  lastTurnMs?: number;
  state: StallState;
  stateSince: number;
}

export interface StallTransition {
  sessionID: string;
  from: StallState;
  to: StallState;
  at: number;
  idleMs: number;
  tracked: TrackedSession;
}

export type WatchdogEventType = "WARN" | "RESUME" | "ABORT";

export interface RecentWatchdogEvent {
  time: number;
  type: WatchdogEventType;
  sessionID: string;
  agent: string;
}

export interface WatchdogAbortResult {
  aborted: boolean;
  sessionID: string;
  agent?: string;
  idleMs: number;
}
