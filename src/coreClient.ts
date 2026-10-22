// SECTION 3: Talking to CORE
// CoreClient is the only part of Provenance that contacts the CORE API. It:
//   - searches for works, fetches one work, and fetches a work's full text;
//   - paces itself: at least 1.5 seconds between requests, and when CORE says our allowance
//     (10 requests a minute) is used up, it waits until CORE says we may continue;
//   - retries politely when CORE says "too many requests" (429) or has a server error (5xx);
//   - remembers answers: in memory for this session, and on disk for 7 days (data/cache/);
//   - turns technical failures into plain-English messages that say what to do next.
// The API key is sent only in a request header. It never appears in URLs, logs, errors or the cache.

import { loadConfig, type Config } from "./config.ts";
import { DiskCache } from "./diskCache.ts";
import { sourceFromCore, usableFullText, type Source } from "./models.ts";

// ---------- the "transport": the one function that actually goes on the internet ----------
// Tests swap in a fake transport so they run offline.

export interface TransportResponse {
  status: number;
  body: string;
  /** Response headers, with lower-case names. */
  headers: Record<string, string>;
}

export type Transport = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number },
) => Promise<TransportResponse>;

export const fetchTransport: Transport = async (url, init) => {
  const response = await fetch(url, {
    headers: init.headers,
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(response.headers),
  };
};

// ---------- errors ----------

export class CoreApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CoreApiError";
    this.status = status;
  }
}

function friendlyHttpError(status: number): CoreApiError {
  if (status === 401 || status === 403) {
    return new CoreApiError(
      "CORE rejected the API key. Check CORE_API_KEY in your .env file (no spaces or quotes), " +
        "or remove it to search without a key.",
      status,
    );
  }
  if (status === 404) return new CoreApiError("CORE has no work with that ID.", status);
  if (status === 429) {
    return new CoreApiError(
      "CORE is limiting how fast we can search (10 requests a minute). Wait a minute and try again.",
      status,
    );
  }
  if (status >= 500) {
    return new CoreApiError(
      "CORE had a server error with this request. Try again in a few minutes, or simplify the search " +
        "(fewer OR terms or quoted phrases).",
      status,
    );
  }
  return new CoreApiError(`CORE refused the request (HTTP ${status}). Try rewording the search.`, status);
}

// ---------- reading CORE's rate-limit headers ----------

/** CORE's X-RateLimit-Retry-After is a timestamp like "2026-10-22T01:05:42+0000". */
export function parseResetTime(value: string | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(time) ? null : time;
}

// ---------- search options and results ----------

export interface SearchOptions {
  /** How many results to return (1 to 100). Default 10. */
  limit?: number;
  /** Skip this many results, for paging. Default 0. */
  offset?: number;
  /** Only works published in or after this year. */
  yearFrom?: number;
  /** Only works published in or before this year. */
  yearTo?: number;
}

export interface SearchResult {
  /** The exact query sent to CORE, including year filters. */
  query: string;
  totalHits: number;
  results: Source[];
  /** Records CORE sent that we couldn't understand (skipped, not fatal). */
  skipped: number;
}

export interface FullTextResult {
  coreId: string;
  title: string;
  available: boolean;
  /** The requested slice of the text, or null when it isn't available. */
  text: string | null;
  /** Total characters in the full text (0 when unavailable). */
  totalChars: number;
  offset: number;
  /** Plain-English note on what was returned and what to do next. */
  message: string;
}

/** Adds year limits to a CORE query using its own query language. */
export function buildQuery(query: string, options: SearchOptions = {}): string {
  const base = query.trim();
  if (base === "") throw new CoreApiError("The search is empty. Type some words to search for.");
  const filters: string[] = [];
  if (options.yearFrom !== undefined) filters.push(`yearPublished>=${options.yearFrom}`);
  if (options.yearTo !== undefined) filters.push(`yearPublished<=${options.yearTo}`);
  return filters.length === 0 ? base : `(${base}) AND ${filters.join(" AND ")}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ---------- the client ----------

export interface CoreClientOptions {
  config?: Config;
  transport?: Transport;
  /** Where to keep answers between sessions. Pass null to turn the disk cache off (tests do). */
  diskCache?: DiskCache | null;
  /** Pause function; tests replace it so they don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in milliseconds; tests replace it. */
  now?: () => number;
}

/** Never wait longer than this for CORE's allowance to reset; give a friendly error instead. */
const MAX_WAIT_MS = 75_000;
/** Server errors (5xx) are retried only this many times: a request that breaks CORE usually keeps breaking it. */
const MAX_SERVER_ERROR_RETRIES = 1;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CoreClient {
  readonly config: Config;
  private readonly transport: Transport;
  private readonly diskCache: DiskCache | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly memoryCache = new Map<string, unknown>();
  private lastRequestAt: number | null = null;
  /** When CORE has told us our allowance is used up: don't send anything before this time. */
  private blockedUntil = 0;

  constructor(options: CoreClientOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.transport = options.transport ?? fetchTransport;
    this.diskCache = options.diskCache === undefined ? new DiskCache() : options.diskCache;
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
  }

  get hasApiKey(): boolean {
    return this.config.coreApiKey !== null;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const { query: fullQuery, data } = await this.searchRaw(query, options);
    const record = (data ?? {}) as { totalHits?: unknown; results?: unknown };

    const results: Source[] = [];
    let skipped = 0;
    for (const raw of Array.isArray(record.results) ? record.results : []) {
      try {
        results.push(sourceFromCore(raw));
      } catch {
        skipped += 1;
      }
    }
    const totalHits = typeof record.totalHits === "number" ? record.totalHits : results.length;
    return { query: fullQuery, totalHits, results, skipped };
  }

  /** The search exactly as CORE returned it, before tidying. Used by scripts/inspectCore.ts. */
  async searchRaw(query: string, options: SearchOptions = {}): Promise<{ query: string; data: unknown }> {
    const fullQuery = buildQuery(query, options);
    const params = new URLSearchParams({
      q: fullQuery,
      limit: String(clamp(options.limit ?? 10, 1, 100)),
      offset: String(clamp(options.offset ?? 0, 0, 10_000)),
    });
    return { query: fullQuery, data: await this.getJson(`/search/works?${params}`) };
  }

  async getWork(coreId: string): Promise<Source> {
    return sourceFromCore(await this.getRawWork(coreId));
  }

  /** Returns a slice of a work's full text, so long texts can be read in pieces. */
  async getFullText(coreId: string, options: { offset?: number; maxChars?: number } = {}): Promise<FullTextResult> {
    const raw = (await this.getRawWork(coreId)) as Record<string, unknown>;
    const source = sourceFromCore(raw);
    const body = usableFullText(raw.fullText);

    if (body === null) {
      const where = source.downloadUrl ?? source.fullTextUrls[0] ?? source.landingUrl;
      const keyHint = this.hasApiKey ? "" : " CORE only shares full text with API-key users, so adding a key may help.";
      return {
        coreId: source.coreId,
        title: source.title,
        available: false,
        text: null,
        totalChars: 0,
        offset: 0,
        message:
          `CORE has no readable full text for this work.${keyHint}` +
          (where ? ` An open copy may be at ${where}.` : " Try the researcher's library or interlibrary loan."),
      };
    }

    const offset = clamp(options.offset ?? 0, 0, body.length);
    const maxChars = clamp(options.maxChars ?? 20_000, 1, 100_000);
    const slice = body.slice(offset, offset + maxChars);
    const end = offset + slice.length;
    return {
      coreId: source.coreId,
      title: source.title,
      available: true,
      text: slice,
      totalChars: body.length,
      offset,
      message:
        end < body.length
          ? `Showing characters ${offset} to ${end} of ${body.length}. Ask again with offset ${end} for more.`
          : `Showing characters ${offset} to ${end} of ${body.length} (the end of the text).`,
    };
  }

  // ---------- internals ----------

  private async getRawWork(coreId: string): Promise<unknown> {
    const id = coreId.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new CoreApiError(`"${coreId}" doesn't look like a CORE ID. CORE IDs are numbers like 123456.`);
    }
    return this.getJson(`/works/${encodeURIComponent(id)}`);
  }

  /** Fetches a path from CORE as JSON, using the caches, the pacing rules and retries. */
  private async getJson(pathAndQuery: string): Promise<unknown> {
    const url = `${this.config.coreBaseUrl}${pathAndQuery}`;
    // Answers differ with and without a key (full text), so the cache keeps them apart.
    const cacheKey = `${this.hasApiKey ? "keyed" : "keyless"} ${url}`;
    if (this.memoryCache.has(cacheKey)) return this.memoryCache.get(cacheKey);
    const saved = this.diskCache?.get(cacheKey);
    if (saved !== undefined) {
      this.memoryCache.set(cacheKey, saved);
      return saved;
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.coreApiKey) headers.Authorization = `Bearer ${this.config.coreApiKey}`;

    let serverErrorRetries = 0;
    for (let attempt = 0; ; attempt += 1) {
      await this.waitForTurn();
      let response: TransportResponse;
      try {
        response = await this.transport(url, { headers, timeoutMs: this.config.timeoutMs });
      } catch {
        if (attempt < this.config.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new CoreApiError("Couldn't reach CORE. Check your internet connection and try again.");
      }
      this.noteRateLimit(response.headers);

      if (response.status === 429 && attempt < this.config.maxRetries) {
        const waitMs = this.rateLimitWaitMs(response.headers, attempt);
        if (waitMs > MAX_WAIT_MS) throw this.tooLongError(this.now() + waitMs);
        await this.sleep(waitMs);
        continue;
      }
      if (response.status >= 500 && serverErrorRetries < MAX_SERVER_ERROR_RETRIES && attempt < this.config.maxRetries) {
        serverErrorRetries += 1;
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw friendlyHttpError(response.status);

      let data: unknown;
      try {
        data = JSON.parse(response.body);
      } catch {
        throw new CoreApiError("CORE sent back something that isn't valid data. Try again shortly.");
      }
      this.memoryCache.set(cacheKey, data);
      this.diskCache?.set(cacheKey, data);
      return data;
    }
  }

  /** Waits for the 1.5 s gap and for any pause CORE has asked for. */
  private async waitForTurn(): Promise<void> {
    const gapEnds = this.lastRequestAt === null ? 0 : this.lastRequestAt + this.config.minIntervalMs;
    const waitMs = Math.max(gapEnds, this.blockedUntil) - this.now();
    if (waitMs > MAX_WAIT_MS) throw this.tooLongError(this.now() + waitMs);
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastRequestAt = this.now();
  }

  /** If CORE says no requests remain, remember when the allowance resets. */
  private noteRateLimit(headers: Record<string, string>): void {
    const remaining = Number(headers["x-ratelimit-remaining"]);
    const resetAt = parseResetTime(headers["x-ratelimit-retry-after"]);
    if (remaining === 0 && resetAt !== null) this.blockedUntil = resetAt + 500;
  }

  /** After a 429: wait until CORE's reset time, or its Retry-After seconds, or back off 2 s, 4 s, 8 s... */
  private rateLimitWaitMs(headers: Record<string, string>, attempt: number): number {
    const resetAt = parseResetTime(headers["x-ratelimit-retry-after"]);
    if (resetAt !== null) return Math.max(resetAt + 500 - this.now(), 1000);
    const seconds = Number(headers["retry-after"]);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return this.backoffMs(attempt);
  }

  private backoffMs(attempt: number): number {
    return Math.min(2000 * 2 ** attempt, 60_000);
  }

  private tooLongError(untilMs: number): CoreApiError {
    const at = new Date(untilMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return new CoreApiError(
      `CORE's request allowance is used up. Try again after about ${at}.`,
      429,
    );
  }
}
