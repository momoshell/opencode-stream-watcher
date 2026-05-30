import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DurationConfig, PerAgentThresholdConfig, WatchdogConfig } from "./types.js";

type LogLevel = "warn" | "error";
type GlobalScalarConfigKey = "warnThresholdMs" | "abortThresholdMs" | "tickMs" | "toast" | "log";
type ThresholdConfigKey = "warnThresholdMs" | "abortThresholdMs";
type DurationConfigKey = keyof DurationConfig;
type DurationThresholdConfigKey = "minToastMs" | "slowToastMs";
type PerAgentConfigKey = ThresholdConfigKey | "duration";

const GLOBAL_SCALAR_CONFIG_KEYS: readonly GlobalScalarConfigKey[] = [
  "warnThresholdMs",
  "abortThresholdMs",
  "tickMs",
  "toast",
  "log",
];
const DURATION_CONFIG_KEYS: readonly DurationConfigKey[] = ["enabled", "minToastMs", "slowToastMs"];
const PER_AGENT_THRESHOLD_CONFIG_KEYS: readonly ThresholdConfigKey[] = [
  "warnThresholdMs",
  "abortThresholdMs",
];
const PER_AGENT_CONFIG_KEYS: readonly PerAgentConfigKey[] = [
  "warnThresholdMs",
  "abortThresholdMs",
  "duration",
];
const PER_AGENT_DURATION_THRESHOLD_CONFIG_KEYS: readonly DurationThresholdConfigKey[] = [
  "minToastMs",
  "slowToastMs",
];

export type ConfigLogger = (message: string, level?: LogLevel) => void;

export type LoadWatchdogConfigOptions = {
  projectRoot?: string;
  globalConfigPath?: string;
  projectConfigPath?: string;
  logger?: ConfigLogger;
};

type PluginConfigRoot = {
  "stream-watchdog"?: unknown;
};

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  warnThresholdMs: 90_000,
  abortThresholdMs: 600_000,
  tickMs: 10_000,
  toast: true,
  log: true,
  duration: {
    enabled: true,
    minToastMs: 5_000,
    slowToastMs: 30_000,
  },
  perAgent: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePositiveNumber(value: unknown): number | null {
  if (!hasFiniteNumber(value) || value <= 0) {
    return null;
  }

  return value;
}

function parseNonNegativeNumber(value: unknown): number | null {
  if (!hasFiniteNumber(value) || value < 0) {
    return null;
  }

  return value;
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isSupportedKey<T extends string>(key: string, supportedKeys: readonly T[]): key is T {
  return (supportedKeys as readonly string[]).includes(key);
}

function warnUnsupportedKeys<T extends string>(
  source: Record<string, unknown>,
  supportedKeys: readonly T[],
  logger: ConfigLogger,
  messageForKey: (key: string) => string,
): void {
  for (const key of Object.keys(source)) {
    if (isSupportedKey(key, supportedKeys)) {
      continue;
    }

    logger(messageForKey(key), "warn");
  }
}

function cloneDurationConfig(config: DurationConfig): DurationConfig {
  return { ...config };
}

function clonePerAgentConfig(
  perAgent: WatchdogConfig["perAgent"],
): WatchdogConfig["perAgent"] {
  const cloned: WatchdogConfig["perAgent"] = {};

  for (const [agentName, agentConfig] of Object.entries(perAgent)) {
    const clonedAgentConfig: PerAgentThresholdConfig = { ...agentConfig };
    if (agentConfig.duration !== undefined) {
      clonedAgentConfig.duration = { ...agentConfig.duration };
    }

    cloned[agentName] = clonedAgentConfig;
  }

  return cloned;
}

function readNamespace(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const namespace = value["stream-watchdog"];
  return isRecord(namespace) ? namespace : {};
}

async function readConfigNamespace(filePath: string): Promise<Record<string, unknown>> {
  const rawText = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(rawText);

  if (!isRecord(parsed)) {
    return {};
  }

  return readNamespace(parsed as PluginConfigRoot);
}

function applyValidatedGlobalValue(
  config: WatchdogConfig,
  source: Record<string, unknown>,
  key: GlobalScalarConfigKey,
  fallback: WatchdogConfig,
  logger: ConfigLogger,
): void {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  if (key === "toast" || key === "log") {
    const parsed = parseBoolean(value);
    if (parsed === null) {
      logger(`Invalid stream-watchdog.${key} value; expected boolean. Using fallback.`, "warn");
      config[key] = fallback[key];
      return;
    }

    config[key] = parsed;
    return;
  }

  if (key === "abortThresholdMs") {
    const parsed = parseNonNegativeNumber(value);
    if (parsed === null) {
      logger(
        `Invalid stream-watchdog.${key} value; expected non-negative number. Using fallback.`,
        "warn",
      );
      config[key] = fallback[key];
      return;
    }

    config[key] = parsed;
    return;
  }

  const parsed = parsePositiveNumber(value);
  if (parsed === null) {
    logger(`Invalid stream-watchdog.${key} value; expected positive number. Using fallback.`, "warn");
    config[key] = fallback[key];
    return;
  }

  config[key] = parsed;
}

function mergeConfig(
  current: WatchdogConfig,
  source: Record<string, unknown>,
  fallback: WatchdogConfig,
  logger: ConfigLogger,
): WatchdogConfig {
  const next: WatchdogConfig = {
    ...current,
    duration: cloneDurationConfig(current.duration),
    perAgent: clonePerAgentConfig(current.perAgent),
  };

  for (const key of GLOBAL_SCALAR_CONFIG_KEYS) {
    applyValidatedGlobalValue(next, source, key, fallback, logger);
  }

  applyValidatedDurationConfig(next, source, fallback, logger);
  mergePerAgentConfig(next, source, logger);

  return next;
}

function applyValidatedDurationConfig(
  config: WatchdogConfig,
  source: Record<string, unknown>,
  fallback: WatchdogConfig,
  logger: ConfigLogger,
): void {
  const rawDuration = source["duration"];

  if (rawDuration === undefined) {
    return;
  }

  if (!isRecord(rawDuration)) {
    logger("Invalid stream-watchdog.duration value; expected object. Using fallback.", "warn");
    config.duration = cloneDurationConfig(fallback.duration);
    return;
  }

  const nextDuration = cloneDurationConfig(config.duration);

  for (const key of DURATION_CONFIG_KEYS) {
    applyValidatedDurationValue(nextDuration, rawDuration, key, fallback.duration, logger);
  }

  warnUnsupportedKeys(rawDuration, DURATION_CONFIG_KEYS, logger, (nestedKey) => (
    `Invalid stream-watchdog.duration.${nestedKey} value; key is not supported. Ignoring.`
  ));

  config.duration = nextDuration;
}

function applyValidatedDurationValue(
  target: DurationConfig,
  source: Record<string, unknown>,
  key: DurationConfigKey,
  fallback: DurationConfig,
  logger: ConfigLogger,
): void {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  if (key === "enabled") {
    const parsed = parseBoolean(value);
    if (parsed === null) {
      logger(`Invalid stream-watchdog.duration.${key} value; expected boolean. Using fallback.`, "warn");
      target[key] = fallback[key];
      return;
    }

    target[key] = parsed;
    return;
  }

  const parsed = parsePositiveNumber(value);
  if (parsed === null) {
    logger(`Invalid stream-watchdog.duration.${key} value; expected positive number. Using fallback.`, "warn");
    target[key] = fallback[key];
    return;
  }

  target[key] = parsed;
}

function mergePerAgentConfig(
  config: WatchdogConfig,
  source: Record<string, unknown>,
  logger: ConfigLogger,
): void {
  const rawPerAgent = source["perAgent"];

  if (rawPerAgent === undefined) {
    return;
  }

  if (!isRecord(rawPerAgent)) {
    logger("Invalid stream-watchdog.perAgent value; expected object. Ignoring.", "warn");
    return;
  }

  for (const [agentName, rawAgentConfig] of Object.entries(rawPerAgent)) {
    const pathPrefix = `stream-watchdog.perAgent.${agentName}`;

    if (!isRecord(rawAgentConfig)) {
      logger(`Invalid ${pathPrefix} value; expected object. Ignoring.`, "warn");
      continue;
    }

    const mergedAgentConfig: PerAgentThresholdConfig = {
      ...(config.perAgent[agentName] ?? {}),
    };
    const existingDuration = config.perAgent[agentName]?.duration;
    if (existingDuration !== undefined) {
      mergedAgentConfig.duration = { ...existingDuration };
    }

    for (const key of PER_AGENT_THRESHOLD_CONFIG_KEYS) {
      mergePerAgentThresholdValue(mergedAgentConfig, rawAgentConfig, key, pathPrefix, logger);
    }

    mergePerAgentDurationConfig(mergedAgentConfig, rawAgentConfig, pathPrefix, logger);

    warnUnsupportedKeys(rawAgentConfig, PER_AGENT_CONFIG_KEYS, logger, (nestedKey) => (
      `Invalid ${pathPrefix}.${nestedKey} value; key is not supported for per-agent overrides. Ignoring.`
    ));

    if (Object.keys(mergedAgentConfig).length > 0) {
      config.perAgent[agentName] = mergedAgentConfig;
    }
  }
}

function mergePerAgentDurationConfig(
  target: PerAgentThresholdConfig,
  source: Record<string, unknown>,
  pathPrefix: string,
  logger: ConfigLogger,
): void {
  const rawDuration = source["duration"];

  if (rawDuration === undefined) {
    return;
  }

  if (!isRecord(rawDuration)) {
    logger(`Invalid ${pathPrefix}.duration value; expected object. Ignoring.`, "warn");
    return;
  }

  const mergedDuration = {
    ...(target.duration ?? {}),
  };

  for (const key of PER_AGENT_DURATION_THRESHOLD_CONFIG_KEYS) {
    mergePerAgentDurationThresholdValue(mergedDuration, rawDuration, key, `${pathPrefix}.duration`, logger);
  }

  warnUnsupportedKeys(rawDuration, PER_AGENT_DURATION_THRESHOLD_CONFIG_KEYS, logger, (nestedKey) => (
    `Invalid ${pathPrefix}.duration.${nestedKey} value; key is not supported for per-agent duration overrides. Ignoring.`
  ));

  if (Object.keys(mergedDuration).length > 0) {
    target.duration = mergedDuration;
  }
}

function mergePerAgentDurationThresholdValue(
  target: NonNullable<PerAgentThresholdConfig["duration"]>,
  source: Record<string, unknown>,
  key: DurationThresholdConfigKey,
  pathPrefix: string,
  logger: ConfigLogger,
): void {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  const parsed = parsePositiveNumber(value);
  if (parsed === null) {
    logger(`Invalid ${pathPrefix}.${key} value; expected positive number. Ignoring.`, "warn");
    return;
  }

  target[key] = parsed;
}

function mergePerAgentThresholdValue(
  target: { warnThresholdMs?: number; abortThresholdMs?: number },
  source: Record<string, unknown>,
  key: ThresholdConfigKey,
  pathPrefix: string,
  logger: ConfigLogger,
): void {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  if (key === "abortThresholdMs") {
    const parsed = parseNonNegativeNumber(value);
    if (parsed === null) {
      logger(`Invalid ${pathPrefix}.${key} value; expected non-negative number. Ignoring.`, "warn");
      return;
    }

    target[key] = parsed;
    return;
  }

  const parsed = parsePositiveNumber(value);
  if (parsed === null) {
    logger(`Invalid ${pathPrefix}.${key} value; expected positive number. Ignoring.`, "warn");
    return;
  }

  target[key] = parsed;
}

function isMissingFileError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  return error["code"] === "ENOENT";
}

function warnConfigReadError(configPath: string, error: unknown, logger: ConfigLogger): void {
  if (error instanceof Error && error.message.length > 0) {
    logger(`Failed to load ${configPath}: ${error.message}`, "warn");
    return;
  }

  logger(`Failed to load ${configPath}: unknown error`, "warn");
}

function getGlobalConfigPath(options: LoadWatchdogConfigOptions): string {
  return options.globalConfigPath ?? join(homedir(), ".config", "opencode", "opencode.json");
}

function getProjectConfigPath(options: LoadWatchdogConfigOptions): string {
  const root = options.projectRoot ?? process.cwd();
  return options.projectConfigPath ?? join(root, "opencode.json");
}

export function getDefaultWatchdogConfig(): WatchdogConfig {
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    duration: cloneDurationConfig(DEFAULT_WATCHDOG_CONFIG.duration),
    perAgent: {},
  };
}

export async function loadWatchdogConfig(
  options: LoadWatchdogConfigOptions = {},
): Promise<WatchdogConfig> {
  const logger = options.logger ?? (() => undefined);
  const paths = [getGlobalConfigPath(options), getProjectConfigPath(options)];
  const defaults = getDefaultWatchdogConfig();

  let merged = getDefaultWatchdogConfig();

  for (const configPath of paths) {
    try {
      const source = await readConfigNamespace(configPath);
      merged = mergeConfig(merged, source, defaults, logger);
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        warnConfigReadError(configPath, error, logger);
      }
    }
  }

  return merged;
}
