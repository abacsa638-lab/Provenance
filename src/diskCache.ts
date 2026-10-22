// Disk cache: remembers CORE answers between sessions
// Each answer is saved as a small JSON file in data/cache/ (git-ignored), named after a
// fingerprint of the request. Answers older than 7 days are treated as stale and fetched again.
// This keeps repeat searches fast and saves our limited CORE requests (10 per minute).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.ts";

export const DEFAULT_CACHE_DIR = path.join(PROJECT_ROOT, "data", "cache");
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  key: string;
  savedAt: number;
  data: unknown;
}

export class DiskCache {
  readonly dir: string;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: { dir?: string; maxAgeMs?: number; now?: () => number } = {}) {
    this.dir = options.dir ?? DEFAULT_CACHE_DIR;
    this.maxAgeMs = options.maxAgeMs ?? SEVEN_DAYS_MS;
    this.now = options.now ?? Date.now;
  }

  private fileFor(key: string): string {
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return path.join(this.dir, `${fingerprint}.json`);
  }

  /** The saved answer, or undefined if there isn't one or it's older than 7 days. */
  get(key: string): unknown {
    try {
      const entry = JSON.parse(readFileSync(this.fileFor(key), "utf8")) as CacheEntry;
      if (entry.key !== key || this.now() - entry.savedAt > this.maxAgeMs) return undefined;
      return entry.data;
    } catch {
      return undefined; // missing or damaged file: just fetch again
    }
  }

  /** Saves an answer. Writes to a temporary file first, so a crash never leaves half a file. */
  set(key: string, data: unknown): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(key);
      const temp = `${file}.${process.pid}.tmp`;
      const entry: CacheEntry = { key, savedAt: this.now(), data };
      writeFileSync(temp, JSON.stringify(entry));
      renameSync(temp, file);
    } catch (error) {
      // A cache that can't save shouldn't stop the research; note it and carry on.
      console.error("[provenance] couldn't save to the disk cache:", (error as Error).message);
    }
  }
}
