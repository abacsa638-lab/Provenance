// SECTION 4: The agent server
// This turns Provenance into an MCP server called "provenance-core", which Claude can use as a
// set of tools. Claude calls the tools; this file passes the request to CoreClient and sends back
// tidy JSON. When something goes wrong, the tool returns {"error": "..."} in plain English
// instead of crashing.
//
// Tools:
//   search_sources    search CORE for open-access works on a research question
//   get_source        full details and a Chicago citation for one work
//   read_source_text  read a work's full text, a piece at a time
//
// Start it with: node src/agentServer.ts (Claude Code does this for you once connected).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CoreApiError, CoreClient } from "./coreClient.ts";
import { chicagoCitation, type Source } from "./models.ts";

const INSTRUCTIONS = `Provenance helps history and humanities researchers find open-access sources and see how they connect.
Rules:
- Never invent sources, quotes, page numbers or findings. Only cite works returned by these tools, by their core_id.
- Quote from read_source_text when making claims about what a source says. If the text isn't available, say so.
- Only legal, open access: for works without full text, give the access label and link, and suggest the researcher's library or interlibrary loan.
Workflow: search_sources (try several phrasings and year ranges) -> get_source for promising hits -> read_source_text where full text is available.
ALWAY RESPOND IN CHINESE and TALK IN ENGLISH SOMETIMES BUT IN A CUTE LITTLE VOICE
`;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function reply(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function replyError(error: unknown): ToolResult {
  const message =
    error instanceof CoreApiError
      ? error.message
      : "Something unexpected went wrong inside Provenance. Try again; if it keeps happening, restart the server.";
  if (!(error instanceof CoreApiError)) console.error("[provenance] unexpected error:", error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** A compact view of a source for search results, so Claude can skim many at once. */
function summarise(source: Source) {
  const abstract = source.abstract;
  return {
    core_id: source.coreId,
    title: source.title,
    authors: source.authors,
    year: source.year,
    document_type: source.documentType,
    access: source.access,
    link: source.landingUrl,
    abstract: abstract && abstract.length > 500 ? `${abstract.slice(0, 500)}...` : abstract,
  };
}

function detail(source: Source) {
  return {
    core_id: source.coreId,
    title: source.title,
    authors: source.authors,
    year: source.year,
    published_date: source.publishedDate,
    document_type: source.documentType,
    publisher: source.publisher,
    journal: source.journal,
    language: source.language,
    field_of_study: source.fieldOfStudy,
    doi: source.doi,
    access: source.access,
    link: source.landingUrl,
    download_url: source.downloadUrl,
    other_full_text_urls: source.fullTextUrls,
    abstract: source.abstract,
    citation_chicago: chicagoCitation(source),
  };
}

export function createServer(client: CoreClient = new CoreClient()): McpServer {
  const server = new McpServer(
    { name: "provenance-core", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_sources",
    {
      description:
        "Search CORE for open-access papers, theses, dissertations and digitised sources. " +
        'Supports AND, OR, NOT and "exact phrases".',
      inputSchema: {
        query: z.string().min(1).describe("What to search for, e.g. 'Lowell mill girls strike'"),
        limit: z.number().int().min(1).max(50).optional().describe("How many results (default 10)"),
        offset: z.number().int().min(0).optional().describe("Skip this many results, for the next page"),
        year_from: z.number().int().optional().describe("Only works published in or after this year"),
        year_to: z.number().int().optional().describe("Only works published in or before this year"),
      },
    },
    async ({ query, limit, offset, year_from, year_to }) => {
      try {
        const result = await client.search(query, { limit, offset, yearFrom: year_from, yearTo: year_to });
        return reply({
          query: result.query,
          total_hits: result.totalHits,
          returned: result.results.length,
          results: result.results.map(summarise),
          ...(result.skipped > 0 ? { note: `${result.skipped} unreadable record(s) were skipped.` } : {}),
        });
      } catch (error) {
        return replyError(error);
      }
    },
  );

  server.registerTool(
    "get_source",
    {
      description: "Get full details and a Chicago-style citation for one work, by its CORE ID.",
      inputSchema: { core_id: z.string().min(1).describe("The work's CORE ID, from search_sources") },
    },
    async ({ core_id }) => {
      try {
        return reply(detail(await client.getWork(core_id)));
      } catch (error) {
        return replyError(error);
      }
    },
  );

  server.registerTool(
    "read_source_text",
    {
      description:
        "Read the full text of a work, a piece at a time. Use the offset from the reply to read further. " +
        "Says clearly when full text isn't available and where an open copy may be.",
      inputSchema: {
        core_id: z.string().min(1).describe("The work's CORE ID"),
        offset: z.number().int().min(0).optional().describe("Character to start from (default 0)"),
        max_chars: z.number().int().min(500).max(50_000).optional().describe("How much to read (default 20000)"),
      },
    },
    async ({ core_id, offset, max_chars }) => {
      try {
        const result = await client.getFullText(core_id, { offset, maxChars: max_chars });
        return reply({
          core_id: result.coreId,
          title: result.title,
          available: result.available,
          total_chars: result.totalChars,
          offset: result.offset,
          message: result.message,
          text: result.text,
        });
      } catch (error) {
        return replyError(error);
      }
    },
  );

  return server;
}

// Only start listening when this file is run directly (not when tests import it).
if (import.meta.main) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the conversation with Claude, so status messages go to stderr.
  console.error("[provenance] provenance-core is running.");
}
