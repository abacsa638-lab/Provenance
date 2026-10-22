// SECTION 3: Talking to CORE
// CoreClient is the only part of Provenance that contacts the CORE API. It:
//   - searches for works, fetches one work, and fetches a work's full text;
//   - waits at least 1.5 seconds between requests so we stay inside the free-tier limit;
//   - retries politely when CORE says "too many requests" (429) or has a server error (5xx);
//   - remembers answers it has already fetched (in memory, for this session);
//   - turns technical failures into plain-English messages that say what to do next.
// The API key is sent only in a request header. It never appears in URLs, logs or errors.

import { loadConfig, type Config } from "./config.ts";
import { sourceFromCore, usableFullText, type Source } from "./models.ts";

// ---------- the "transport": the one function that actually goes on the internet ----------
// Tests swap in a fake transport so they run offline.

export interface TransportResponse {
  status: number;
  body: string;
  /** The Retry-After header, if CORE sent one. */
  retryAfter: string | null;
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
    retryAfter: response.headers.get("retry-after"),
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
      "CORE is limiting how fast we can search. Wait a minute and try again.",
      status,
    );
  }
  if (status >= 500) {
    return new CoreApiError("CORE is having server trouble right now. Try again in a few minutes.", status);
  }
  return new CoreApiError(`CORE refused the request (HTTP ${status}). Try rewording the search.`, status);
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
  /** Pause function; tests replace it so they don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in milliseconds; tests replace it. */
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CoreClient {
  readonly config: Config;
  private readonly transport: Transport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cache = new Map<string, unknown>();
  private lastRequestAt: number | null = null;

  constructor(options: CoreClientOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.transport = options.transport ?? fetchTransport;
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
  }

  get hasApiKey(): boolean {
    return this.config.coreApiKey !== null;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const fullQuery = buildQuery(query, options);
    const params = new URLSearchParams({
      q: fullQuery,
      limit: String(clamp(options.limit ?? 10, 1, 100)),
      offset: String(clamp(options.offset ?? 0, 0, 10_000)),
    });
    const data = await this.getJson(`/search/works?${params}`);
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

  /** Fetches a path from CORE as JSON, using the cache, the pacing rule and retries. */
  private async getJson(pathAndQuery: string): Promise<unknown> {
    const url = `${this.config.coreBaseUrl}${pathAndQuery}`;
    if (this.cache.has(url)) return this.cache.get(url);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.coreApiKey) headers.Authorization = `Bearer ${this.config.coreApiKey}`;

    for (let attempt = 0; ; attempt += 1) {
      await this.waitForTurn();
      let response: TransportResponse;
      try {
        response = await this.transport(url, { headers, timeoutMs: this.config.timeoutMs });
      } catch {
        if (attempt < this.config.maxRetries) {
          await this.sleep(this.backoffMs(attempt, null));
          continue;
        }
        throw new CoreApiError("Couldn't reach CORE. Check your internet connection and try again.");
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.config.maxRetries) {
        await this.sleep(this.backoffMs(attempt, response.retryAfter));
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw friendlyHttpError(response.status);

      let data: unknown;
      try {
        data = JSON.parse(response.body);
      } catch {
        throw new CoreApiError("CORE sent back something that isn't valid data. Try again shortly.");
      }
      this.cache.set(url, data);
      return data;
    }
  }

  /** Waits until at least `minIntervalMs` has passed since the previous request. */
  private async waitForTurn(): Promise<void> {
    if (this.lastRequestAt !== null) {
      const waitMs = this.lastRequestAt + this.config.minIntervalMs - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
    }
    this.lastRequestAt = this.now();
  }

  /** How long to wait before retrying: CORE's Retry-After if given, else 2 s, 4 s, 8 s... (max 60 s). */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    return Math.min(2000 * 2 ** attempt, 60_000);
  }
}
