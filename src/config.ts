import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { WatchdogConfig } from "./types.js";

type LogLevel = "warn" | "error";

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
  abortThresholdMs: 0,
  tickMs: 10_000,
  toast: true,
  log: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function applyValidatedValue(
  config: WatchdogConfig,
  source: Record<string, unknown>,
  key: keyof WatchdogConfig,
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
  const next: WatchdogConfig = { ...current };

  applyValidatedValue(next, source, "warnThresholdMs", fallback, logger);
  applyValidatedValue(next, source, "abortThresholdMs", fallback, logger);
  applyValidatedValue(next, source, "tickMs", fallback, logger);
  applyValidatedValue(next, source, "toast", fallback, logger);
  applyValidatedValue(next, source, "log", fallback, logger);

  return next;
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
  return { ...DEFAULT_WATCHDOG_CONFIG };
}

export async function loadWatchdogConfig(
  options: LoadWatchdogConfigOptions = {},
): Promise<WatchdogConfig> {
  const logger = options.logger ?? (() => undefined);
  const paths = [getGlobalConfigPath(options), getProjectConfigPath(options)];
  const defaults = getDefaultWatchdogConfig();

  let merged = { ...defaults };

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
