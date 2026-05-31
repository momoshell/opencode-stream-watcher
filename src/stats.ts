export const DURATION_SAMPLE_LIMIT = 100;

export interface AgentCounters {
  warns: number;
  resumes: number;
  aborts: number;
  noops: number;
}

export interface DurationStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface AgentStats extends AgentCounters {
  duration: DurationStats;
}

export interface WatchdogStatsSnapshot {
  totals: AgentCounters;
  byAgent: Record<string, AgentStats>;
}

export interface FormatStatsOptions {
  heading?: string;
}

export class WatchdogStats {
  private readonly byAgent = new Map<string, AgentBucket>();

  recordWarn(agent: string | null | undefined): void {
    this.recordAgentCounter(agent, "warns");
  }

  recordResume(agent: string | null | undefined): void {
    this.recordAgentCounter(agent, "resumes");
  }

  recordAbort(agent: string | null | undefined): void {
    this.recordAgentCounter(agent, "aborts");
  }

  recordNoop(agent: string | null | undefined): void {
    this.recordAgentCounter(agent, "noops");
  }

  recordDuration(agent: string | null | undefined, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }

    const bucket = this.getOrCreateAgentBucket(agent);
    bucket.durationSamples.push(Math.round(durationMs));

    if (bucket.durationSamples.length > DURATION_SAMPLE_LIMIT) {
      bucket.durationSamples.splice(0, bucket.durationSamples.length - DURATION_SAMPLE_LIMIT);
    }
  }

  snapshot(): WatchdogStatsSnapshot {
    let warns = 0;
    let resumes = 0;
    let aborts = 0;
    let noops = 0;

    const byAgent: Record<string, AgentStats> = {};

    for (const [agent, bucket] of this.byAgent.entries()) {
      warns += bucket.counters.warns;
      resumes += bucket.counters.resumes;
      aborts += bucket.counters.aborts;
      noops += bucket.counters.noops;
      byAgent[agent] = {
        ...bucket.counters,
        duration: summarizeDurations(bucket.durationSamples),
      };
    }

    return {
      totals: { warns, resumes, aborts, noops },
      byAgent,
    };
  }

  private recordAgentCounter(
    rawAgent: string | null | undefined,
    counter: keyof AgentCounters,
  ): void {
    const bucket = this.getOrCreateAgentBucket(rawAgent);
    bucket.counters[counter] += 1;
  }

  private getOrCreateAgentBucket(rawAgent: string | null | undefined): AgentBucket {
    const agent = normalizeAgent(rawAgent);
    const existing = this.byAgent.get(agent);

    if (existing) {
      return existing;
    }

    const next: AgentBucket = {
      counters: {
        warns: 0,
        resumes: 0,
        aborts: 0,
        noops: 0,
      },
      durationSamples: [],
    };

    this.byAgent.set(agent, next);
    return next;
  }
}

export function summarizeDurations(durationSamples: readonly number[]): DurationStats {
  if (durationSamples.length === 0) {
    return {
      count: 0,
      p50: 0,
      p95: 0,
      max: 0,
    };
  }

  const sorted = [...durationSamples].sort((left, right) => left - right);

  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function nearestRank(sortedSamples: readonly number[], percentile: number): number {
  const rank = Math.ceil(percentile * sortedSamples.length);
  const index = Math.max(0, Math.min(sortedSamples.length - 1, rank - 1));

  return sortedSamples[index] ?? 0;
}

function normalizeAgent(rawAgent: string | null | undefined): string {
  const trimmed = rawAgent?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : "unknown";
}

export function formatWatchdogStats(
  snapshot: WatchdogStatsSnapshot,
  options: FormatStatsOptions = {},
): string[] {
  const lines: string[] = [];
  lines.push(options.heading ?? "Aggregate stats:");
  lines.push(
    `- totals warns=${snapshot.totals.warns} resumes=${snapshot.totals.resumes} aborts=${snapshot.totals.aborts} noops=${snapshot.totals.noops}`,
  );

  const byAgentNames = Object.keys(snapshot.byAgent).sort((left, right) => left.localeCompare(right));

  if (byAgentNames.length === 0) {
    lines.push("- byAgent none");
  } else {
    for (const agent of byAgentNames) {
      const agentStats = snapshot.byAgent[agent];
      if (!agentStats) {
        continue;
      }

      lines.push(
        `- byAgent agent=${agent} warns=${agentStats.warns} resumes=${agentStats.resumes} aborts=${agentStats.aborts} noops=${agentStats.noops} durationCount=${agentStats.duration.count} durationP50Ms=${agentStats.duration.p50} durationP95Ms=${agentStats.duration.p95} durationMaxMs=${agentStats.duration.max}`,
      );
    }
  }

  return lines;
}

interface AgentBucket {
  counters: AgentCounters;
  durationSamples: number[];
}
