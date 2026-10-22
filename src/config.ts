// SECTION 1: Settings
// Gathers everything Provenance needs to know before it talks to the outside world:
// the CORE API key, the API address, and how politely to pace requests.
// The key is read from the computer's environment first, then from the ".env" file
// in the project folder. The key is never printed or logged anywhere.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** The project folder (one level up from src/). */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

export interface Config {
  /** CORE API key, or null when running without one ("keyless" mode). */
  coreApiKey: string | null;
  /** Where the CORE API lives. */
  coreBaseUrl: string;
  /** Minimum pause between two requests to CORE, in milliseconds. */
  minIntervalMs: number;
  /** How many times to retry when CORE says "too busy" (429) or has a server hiccup (5xx). */
  maxRetries: number;
  /** Give up on a single request after this many milliseconds. */
  timeoutMs: number;
}

export const DEFAULTS = {
  coreBaseUrl: "https://api.core.ac.uk/v3",
  // The free tier allows roughly 10 requests a minute; 1.5 s keeps short bursts polite.
  minIntervalMs: 1500,
  maxRetries: 3,
  timeoutMs: 30_000,
} as const;

/** Reads KEY=value lines from a .env file. Returns an empty object if the file is missing. */
export function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const parsed = parseEnv(readFileSync(filePath, "utf8"));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** Treats empty values and the template placeholder as "no key". */
function cleanKey(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("your-") || trimmed === "CHANGE_ME") return null;
  return trimmed;
}

export function loadConfig(options: {
  env?: NodeJS.ProcessEnv;
  envFilePath?: string;
} = {}): Config {
  const env = options.env ?? process.env;
  const fileValues = readEnvFile(options.envFilePath ?? path.join(PROJECT_ROOT, ".env"));
  return {
    coreApiKey: cleanKey(env.CORE_API_KEY) ?? cleanKey(fileValues.CORE_API_KEY),
    coreBaseUrl: DEFAULTS.coreBaseUrl,
    minIntervalMs: DEFAULTS.minIntervalMs,
    maxRetries: DEFAULTS.maxRetries,
    timeoutMs: DEFAULTS.timeoutMs,
  };
}
