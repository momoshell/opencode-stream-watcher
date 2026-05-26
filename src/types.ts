export type StallState = "tracking" | "warned" | "aborted";

export type LastPartKind = "text" | "reasoning" | "tool";

export interface WatchdogConfig {
  warnThresholdMs: number;
  abortThresholdMs: number;
  tickMs: number;
  toast: boolean;
  log: boolean;
}

export interface TrackedSession {
  sessionID: string;
  agent?: string;
  slug?: string;
  lastActivity: number;
  lastPartKind?: LastPartKind;
  state: StallState;
}
