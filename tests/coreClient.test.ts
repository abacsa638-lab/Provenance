// Offline tests for the CORE connector, settings and source model.
// A fake transport stands in for the internet, so these run without a key or a connection.
// Run with: npm test

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import {
  buildQuery,
  CoreApiError,
  CoreClient,
  parseResetTime as parseResetTimeForTest,
  type Transport,
  type TransportResponse,
} from "../src/coreClient.ts";
import { DiskCache } from "../src/diskCache.ts";
import { chicagoCitation, FULL_TEXT_PLACEHOLDER, sourceFromCore } from "../src/models.ts";

// ---------- helpers ----------

const TEST_CONFIG: Config = {
  coreApiKey: "test-key",
  coreBaseUrl: "https://api.example.test/v3",
  minIntervalMs: 1500,
  maxRetries: 3,
  timeoutMs: 1000,
};

const SAMPLE_WORK = {
  id: 4242,
  title: "  The Lowell   Mill Girls and the Strike of 1836 ",
  authors: [{ name: "Smith, Jane" }, { name: "Robert Jones" }],
  abstract: "A study of the 1836 turnout.",
  yearPublished: 2004,
  publishedDate: "2004-05-01T00:00:00",
  doi: "https://doi.org/10.1234/lowell.1836",
  downloadUrl: "https://core.ac.uk/download/4242.pdf",
  sourceFulltextUrls: ["https://repo.example.edu/4242.pdf"],
  links: [{ type: "display", url: "https://core.ac.uk/works/4242" }],
  fullText: "Full text of the thesis. ".repeat(10),
  documentType: "thesis",
  publisher: "University of Massachusetts",
  journals: [],
  language: { code: "en", name: "English" },
  fieldOfStudy: "history",
};

function ok(data: unknown): TransportResponse {
  return { status: 200, body: JSON.stringify(data), headers: {} };
}

/** A fake internet: replies with the queued responses in order, and records each request. */
function fakeTransport(responses: (TransportResponse | Error)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error("fake transport ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

/** A fake clock and sleep: sleeping just moves the clock forward and is recorded. */
function fakeTime() {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
}

function makeClient(responses: (TransportResponse | Error)[], config: Partial<Config> = {}) {
  const fake = fakeTransport(responses);
  const time = fakeTime();
  const client = new CoreClient({ config: { ...TEST_CONFIG, ...config }, transport: fake.transport, diskCache: null, ...time });
  return { client, calls: fake.calls, sleeps: time.sleeps };
}

// ---------- tests ----------

describe("settings", () => {
  it("reads the key from .env, and the environment wins over the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provenance-"));
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "# comment\nCORE_API_KEY=from-file\n");
    assert.equal(loadConfig({ env: {}, envFilePath: envFile }).coreApiKey, "from-file");
    assert.equal(loadConfig({ env: { CORE_API_KEY: "from-env" }, envFilePath: envFile }).coreApiKey, "from-env");
  });

  it("treats a missing or blank key as no key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provenance-"));
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "CORE_API_KEY=\n");
    assert.equal(loadConfig({ env: {}, envFilePath: envFile }).coreApiKey, null);
    assert.equal(loadConfig({ env: {}, envFilePath: path.join(dir, "missing.env") }).coreApiKey, null);
  });
});

describe("source model", () => {
  it("normalises a CORE record into a tidy Source", () => {
    const source = sourceFromCore(SAMPLE_WORK);
    assert.equal(source.coreId, "4242");
    assert.equal(source.title, "The Lowell Mill Girls and the Strike of 1836");
    assert.deepEqual(source.authors, ["Smith, Jane", "Robert Jones"]);
    assert.equal(source.year, 2004);
    assert.equal(source.doi, "10.1234/lowell.1836");
    assert.equal(source.language, "English");
    assert.equal(source.access, "Full text available");
    assert.equal(source.landingUrl, "https://doi.org/10.1234/lowell.1836");
  });

  it("picks the right access label when full text is missing", () => {
    const placeholder = sourceFromCore({ ...SAMPLE_WORK, fullText: FULL_TEXT_PLACEHOLDER });
    assert.equal(placeholder.hasFullText, false);
    assert.equal(placeholder.access, "Open PDF link");

    const abstractOnly = sourceFromCore({ id: 1, title: "T", abstract: "Summary" });
    assert.equal(abstractOnly.access, "Abstract only");
    assert.equal(sourceFromCore({ id: 2, title: "T" }).access, "Metadata only");
  });

  it("survives sparse or messy records, and rejects ones without an ID", () => {
    const source = sourceFromCore({ id: "77", authors: ["Plain Name", null], publishedDate: "1999-01-01" });
    assert.equal(source.title, "(untitled)");
    assert.deepEqual(source.authors, ["Plain Name"]);
    assert.equal(source.year, 1999);
    assert.throws(() => sourceFromCore({ title: "No ID" }));
  });

  it("formats a Chicago citation without inventing details", () => {
    const citation = chicagoCitation(sourceFromCore(SAMPLE_WORK));
    assert.equal(
      citation,
      'Smith, Jane and Robert Jones. "The Lowell Mill Girls and the Strike of 1836." ' +
        "Thesis, University of Massachusetts, 2004. https://doi.org/10.1234/lowell.1836.",
    );
    const bare = chicagoCitation(sourceFromCore({ id: 3, title: "Untraced Pamphlet" }));
    assert.equal(bare, '"Untraced Pamphlet." n.d.');
  });
});

describe("CORE client", () => {
  it("searches with year filters and sends the key only in a header", async () => {
    const { client, calls } = makeClient([ok({ totalHits: 120, results: [SAMPLE_WORK, "junk"] })]);
    const result = await client.search("mill girls", { limit: 5, yearFrom: 1990, yearTo: 2010 });

    assert.equal(result.totalHits, 120);
    assert.equal(result.results.length, 1);
    assert.equal(result.skipped, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/v3/search/works");
    assert.equal(url.searchParams.get("q"), "(mill girls) AND yearPublished>=1990 AND yearPublished<=2010");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(calls[0].headers.Authorization, "Bearer test-key");
    assert.ok(!calls[0].url.includes("test-key"));
  });

  it("leaves out the Authorization header when there's no key", async () => {
    const { client, calls } = makeClient([ok({ totalHits: 0, results: [] })], { coreApiKey: null });
    await client.search("anything");
    assert.equal(calls[0].headers.Authorization, undefined);
  });

  it("rejects an empty search before contacting CORE", async () => {
    const { client, calls } = makeClient([]);
    await assert.rejects(client.search("   "), CoreApiError);
    assert.equal(calls.length, 0);
    assert.equal(buildQuery("x"), "x");
  });

  it("waits at least 1.5 s between requests and caches repeat requests", async () => {
    const { client, calls, sleeps } = makeClient([ok({ totalHits: 0, results: [] }), ok({ totalHits: 0, results: [] })]);
    await client.search("first");
    await client.search("second");
    await client.search("first"); // served from the cache
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [1500]);
  });

  it("backs off and retries after a 429, honouring Retry-After", async () => {
    const { client, calls, sleeps } = makeClient([
      { status: 429, body: "", headers: { "retry-after": "7" } },
      { status: 503, body: "", headers: {} },
      ok({ totalHits: 1, results: [SAMPLE_WORK] }),
    ]);
    const result = await client.search("strike");
    assert.equal(result.results.length, 1);
    assert.equal(calls.length, 3);
    assert.equal(sleeps[0], 7000);
    assert.ok(sleeps.includes(4000), "second retry should wait 4 s");
  });

  it("gives a friendly error when retries run out or the key is wrong", async () => {
    const busy = makeClient(Array(4).fill({ status: 429, body: "", headers: {} }));
    await assert.rejects(busy.client.search("x"), /limiting how fast/);

    const badKey = makeClient([{ status: 401, body: "", headers: {} }]);
    await assert.rejects(badKey.client.search("x"), (error: unknown) => {
      assert.ok(error instanceof CoreApiError);
      assert.match(error.message, /rejected the API key/);
      assert.ok(!error.message.includes("test-key"));
      return true;
    });

    const offline = makeClient(Array(4).fill(new Error("ECONNRESET")));
    await assert.rejects(offline.client.getWork("1"), /internet connection/);
  });

  it("reads full text in slices and explains when it isn't available", async () => {
    const { client } = makeClient([ok(SAMPLE_WORK), ok({ ...SAMPLE_WORK, id: 5, fullText: FULL_TEXT_PLACEHOLDER })]);
    const slice = await client.getFullText("4242", { offset: 0, maxChars: 25 });
    assert.equal(slice.available, true);
    assert.equal(slice.text, "Full text of the thesis. ");
    assert.equal(slice.totalChars, SAMPLE_WORK.fullText.trim().length);
    assert.match(slice.message, /offset 25/);

    const missing = await client.getFullText("5");
    assert.equal(missing.available, false);
    assert.equal(missing.text, null);
    assert.match(missing.message, /core\.ac\.uk\/download\/4242\.pdf/);
  });

  it("follows CORE's own rate-limit headers", async () => {
    // CORE says: no requests left until 10 s from now (on the fake clock).
    const exhausted = { "x-ratelimit-remaining": "0", "x-ratelimit-retry-after": "1970-01-01T00:00:10+0000" };
    const { client, sleeps } = makeClient([
      { status: 200, body: JSON.stringify({ totalHits: 0, results: [] }), headers: exhausted },
      { status: 429, body: "", headers: { ...exhausted, "x-ratelimit-retry-after": "1970-01-01T00:00:30+0000" } },
      ok({ totalHits: 0, results: [] }),
    ]);
    await client.search("first");
    await client.search("second");
    // Waits until 10.5 s before the second request, then until 30.5 s after the 429.
    assert.deepEqual(sleeps, [10_500, 20_000]);
    assert.equal(parseResetTimeForTest("2026-10-22T01:05:42+0000"), Date.UTC(2026, 9, 22, 1, 5, 42));
  });

  it("gives up with a clear time instead of waiting minutes for the allowance", async () => {
    const farFuture = { "x-ratelimit-remaining": "0", "x-ratelimit-retry-after": "1970-01-01T00:10:00+0000" };
    const { client, calls } = makeClient([{ status: 429, body: "", headers: farFuture }]);
    await assert.rejects(client.search("x"), /allowance is used up\. Try again after about/);
    assert.equal(calls.length, 1);
  });

  it("retries a server error only once", async () => {
    const { client, calls } = makeClient(Array(4).fill({ status: 500, body: "", headers: {} }));
    await assert.rejects(client.search("x"), /server error/);
    assert.equal(calls.length, 2);
  });

  it("refuses IDs that could tamper with the URL", async () => {
    const { client, calls } = makeClient([]);
    await assert.rejects(client.getWork("../search/works?q=x"), /doesn't look like a CORE ID/);
    assert.equal(calls.length, 0);
  });
});

describe("disk cache", () => {
  it("remembers answers between sessions and forgets them after 7 days", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provenance-cache-"));
    let clock = 1_000_000;
    const cache = new DiskCache({ dir, now: () => clock });
    const fake = fakeTransport([ok({ totalHits: 3, results: [] }), ok({ totalHits: 4, results: [] })]);
    const makeSession = () =>
      new CoreClient({ config: TEST_CONFIG, transport: fake.transport, diskCache: cache, sleep: async () => {}, now: () => clock });

    assert.equal((await makeSession().search("chartism")).totalHits, 3);
    assert.equal((await makeSession().search("chartism")).totalHits, 3, "a new session reads from disk");
    assert.equal(fake.calls.length, 1);

    clock += 8 * 24 * 60 * 60 * 1000;
    assert.equal((await makeSession().search("chartism")).totalHits, 4, "stale after 7 days");
    assert.equal(fake.calls.length, 2);
  });

  it("keeps keyed and keyless answers apart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provenance-cache-"));
    const cache = new DiskCache({ dir });
    const fake = fakeTransport([ok({ totalHits: 1, results: [] }), ok({ totalHits: 2, results: [] })]);
    const session = (coreApiKey: string | null) =>
      new CoreClient({ config: { ...TEST_CONFIG, coreApiKey }, transport: fake.transport, diskCache: cache, sleep: async () => {} });
    assert.equal((await session(null).search("x")).totalHits, 1);
    assert.equal((await session("k").search("x")).totalHits, 2);
  });
});
