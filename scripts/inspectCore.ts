// Phase 1 helper: look at what CORE really sends back.
// Runs a few real history searches, saves the raw answers to data/samples/ (git-ignored), and
// prints how often each field is filled in, so the source model can be checked against reality.
//
// Usage (PowerShell): node scripts/inspectCore.ts
// It makes about 10 requests and takes roughly a minute because of the polite pacing.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { CoreClient } from "../src/coreClient.ts";
import { usableFullText } from "../src/models.ts";

const TOPICS = [
  { slug: "lowell-mill-girls", query: '"mill girls" AND Lowell' },
  { slug: "ten-hour-movement", query: '"ten hour movement" OR "ten hours movement" OR "ten hours bill"' },
  { slug: "chartism", query: "Chartism OR Chartist" },
];

// Different ways CORE might accept a filter; we compare hit counts to see which ones work.
const SYNTAX_PROBES = [
  { label: "baseline", query: "Chartism" },
  { label: "year >= 2000", query: "Chartism AND yearPublished>=2000" },
  { label: "documentType:thesis", query: "Chartism AND documentType:thesis" },
  { label: 'documentType:"thesis"', query: 'Chartism AND documentType:"thesis"' },
  { label: "documentType:research", query: "Chartism AND documentType:research" },
  { label: "fullText exists", query: "Chartism AND _exists_:fullText" },
];

type Raw = Record<string, unknown>;

function percent(count: number, total: number): string {
  return total === 0 ? "-" : `${Math.round((count / total) * 100)}%`;
}

function describeFields(results: Raw[]): void {
  const counts = new Map<string, number>();
  for (const record of results) {
    for (const [key, value] of Object.entries(record)) {
      const filled = value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
      if (filled) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log("  fields filled in: " + sorted.map(([k, n]) => `${k} ${percent(n, results.length)}`).join(", "));
}

function tally(values: unknown[]): string {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = JSON.stringify(value ?? null);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(", ");
}

async function main(): Promise<void> {
  const client = new CoreClient();
  if (!client.hasApiKey) console.log("Warning: no API key found, so full text will look missing.\n");
  const outDir = path.join(PROJECT_ROOT, "data", "samples");
  mkdirSync(outDir, { recursive: true });

  for (const topic of TOPICS) {
    let query: string;
    let data: unknown;
    try {
      ({ query, data } = await client.searchRaw(topic.query, { limit: 100 }));
    } catch (error) {
      console.log(`== ${topic.slug}: ${topic.query}\n  error: ${(error as Error).message}\n`);
      continue;
    }
    writeFileSync(path.join(outDir, `${topic.slug}.json`), JSON.stringify(data, null, 2));
    const record = data as { totalHits?: number; results?: Raw[] };
    const results = record.results ?? [];

    console.log(`== ${topic.slug}: ${query}`);
    console.log(`  totalHits ${record.totalHits}, returned ${results.length}`);
    describeFields(results);
    const withText = results.filter((r) => usableFullText(r.fullText) !== null).length;
    const withPdf = results.filter((r) => typeof r.downloadUrl === "string" && r.downloadUrl !== "").length;
    console.log(`  usable fullText ${percent(withText, results.length)}, downloadUrl ${percent(withPdf, results.length)}`);
    console.log(`  documentType: ${tally(results.map((r) => r.documentType))}`);
    console.log(`  yearPublished types: ${tally(results.map((r) => typeof r.yearPublished))}`);
    const titles = results.map((r) => String(r.title ?? "").toLowerCase().trim());
    console.log(`  duplicate titles: ${titles.length - new Set(titles).size}`);
    console.log("");
  }

  console.log("== query syntax probes (Chartism)");
  for (const probe of SYNTAX_PROBES) {
    try {
      const { data } = await client.searchRaw(probe.query, { limit: 1 });
      console.log(`  ${probe.label.padEnd(24)} totalHits ${(data as { totalHits?: number }).totalHits}`);
    } catch (error) {
      console.log(`  ${probe.label.padEnd(24)} error: ${(error as Error).message}`);
    }
  }
  console.log(`\nRaw samples saved in ${outDir}`);
}

await main();
