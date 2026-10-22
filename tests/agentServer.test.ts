// Offline tests for the agent server: Claude's view of the tools.
// Connects a real MCP client to the server in memory, with a fake CORE behind it.
// Run with: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/agentServer.ts";
import { CoreClient, type Transport } from "../src/coreClient.ts";

const WORK = { id: 9, title: "Ten Hours' Labour", authors: [{ name: "Ada Clark" }], yearPublished: 1985 };

async function connect(transport: Transport) {
  const core = new CoreClient({
    config: { coreApiKey: null, coreBaseUrl: "https://api.example.test/v3", minIntervalMs: 0, maxRetries: 0, timeoutMs: 1000 },
    transport,
    sleep: async () => {},
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(core).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first.text);
}

describe("agent server", () => {
  it("offers the three CORE tools", async () => {
    const client = await connect(async () => ({ status: 200, body: "{}", retryAfter: null }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_source", "read_source_text", "search_sources"]);
  });

  it("returns compact search results and a Chicago citation", async () => {
    const client = await connect(async (url) => ({
      status: 200,
      body: JSON.stringify(url.includes("/search/") ? { totalHits: 1, results: [WORK] } : WORK),
      retryAfter: null,
    }));
    const search = parse(await client.callTool({ name: "search_sources", arguments: { query: "ten hours" } }));
    assert.equal(search.total_hits, 1);
    assert.equal(search.results[0].core_id, "9");
    assert.equal(search.results[0].access, "Metadata only");

    const source = parse(await client.callTool({ name: "get_source", arguments: { core_id: "9" } }));
    assert.equal(source.citation_chicago, `Clark, Ada. "Ten Hours' Labour." 1985.`);
  });

  it("returns a plain-English error instead of crashing", async () => {
    const client = await connect(async () => ({ status: 404, body: "", retryAfter: null }));
    const result = await client.callTool({ name: "get_source", arguments: { core_id: "123" } });
    assert.equal(result.isError, true);
    assert.deepEqual(parse(result), { error: "CORE has no work with that ID." });
  });
});
