// SECTION 5: Quick test from the terminal
// A simple way to try a CORE search without Claude. Prints whether the API key was found and
// a numbered list of results with their access labels.
//
// Usage (PowerShell):
//   npm run provenance-test -- "Lowell mill girls strike"
//   npm run provenance-test -- "ten-hour movement" --from 1980 --to 2020 --readable
//
// --from / --to   limit by publication year
// --limit N       how many results (default 10)
// --readable      only show works with full text or an open PDF link

import { parseArgs } from "node:util";
import { CoreApiError, CoreClient } from "./coreClient.ts";

function parseYear(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const year = Number(value);
  if (!Number.isInteger(year)) throw new CoreApiError(`${flag} needs a year, like ${flag} 1990.`);
  return year;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "string" },
      readable: { type: "boolean", default: false },
    },
  });

  const query = positionals.join(" ").trim();
  if (query === "") {
    console.log('Usage: npm run provenance-test -- "your search" [--from 1990] [--to 2020] [--readable]');
    return 1;
  }

  const client = new CoreClient();
  console.log(`API key: ${client.hasApiKey ? "found" : "not found (searching without a key: slower, no full text)"}`);

  const result = await client.search(query, {
    limit: values.limit ? Number(values.limit) : 10,
    yearFrom: parseYear(values.from, "--from"),
    yearTo: parseYear(values.to, "--to"),
  });
  console.log(`Query sent: ${result.query}`);
  console.log(`Total matches in CORE: ${result.totalHits.toLocaleString()}\n`);

  const shown = values.readable
    ? result.results.filter((s) => s.access === "Full text available" || s.access === "Open PDF link")
    : result.results;

  if (shown.length === 0) {
    console.log(values.readable ? "None of these results are readable online. Try without --readable." : "No results.");
    return 0;
  }

  shown.forEach((source, index) => {
    const authors = source.authors.length > 0 ? source.authors.slice(0, 3).join("; ") : "Unknown author";
    console.log(`${index + 1}. ${source.title}`);
    console.log(`   ${authors} (${source.year ?? "n.d."})${source.documentType ? `  ·  ${source.documentType}` : ""}`);
    console.log(`   Access: ${source.access}  ·  CORE ID: ${source.coreId}`);
    if (source.landingUrl) console.log(`   ${source.landingUrl}`);
    console.log("");
  });
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof CoreApiError ? `Problem: ${error.message}` : error);
  process.exitCode = 1;
}
