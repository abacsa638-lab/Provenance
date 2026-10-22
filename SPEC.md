# Provenance: Technical Specification (MVP)

> **For Claude Code.** This file is the build plan. Read all of it before writing code. Then work
> through the phases in order. The project owner is a product manager, **not a programmer**, so:
> explain what you're doing in plain language, keep code comments readable by a non-coder, and
> **stop at the end of each phase** to show what works and ask before starting the next.

---

## 1. Product summary

**Provenance** is a research tool for history and humanities graduate students (later: literature
and law). The user gives a research question. Provenance:

1. Searches open-access sources (starting with the CORE API): papers, theses, dissertations,
   digitized primary sources.
2. Groups the sources into **themes** and writes one narrative **deliverable** per theme.
3. Shows **how sources connect**: which ones *cite*, *build on* or *dispute* each other, and what
   **open questions** they leave.
4. Lets the researcher check every claim against its source, and export to Word with a bibliography.

**It is a research tool, not a writing tool.** It helps researchers see the argument so far.
It does not write their paper.

### Non-negotiable principles
- **Never invent sources, quotes, page numbers or findings.** Every claim in a deliverable links to a
  specific source, and where possible to a quoted passage from it. If evidence is missing, say so.
- **Only legal access.** Use open-access content and metadata. Never scrape paywalled sites, bypass
  access controls, or redistribute full texts. For paywalled works, show metadata and abstract and
  point to legal access (an open copy, the user's library, interlibrary loan, the publisher).
- **Be polite to APIs.** Respect rate limits, cache results, and back off on HTTP 429.
- **Secrets stay local.** API keys live only in `.env`, which is git-ignored. Never print, log or
  commit a key.

### Out of scope for the MVP
User accounts, payments, cloud hosting, mobile, paywalled content, and writing papers for the user.

---

## 2. Environment

> **Stack change (2026-10-21):** the owner switched the project from Python to **TypeScript, with
> React for the web UI**. The starter code was rebuilt in TypeScript. Where later sections mention
> Python modules, `uv`, `unittest` or `python-docx`, use the TypeScript equivalents below.

- **OS:** Windows 11. The project lives at `C:\Users\abacs\provenance`. Use `node:path` everywhere.
  Give terminal commands in **PowerShell** syntax.
- **Runtime:** Node.js 24+, which runs `.ts` files directly (no build step). Code must use
  "erasable" TypeScript only (no `enum`, `namespace` or constructor parameter properties). Relative
  imports end in `.ts`. Dependencies go in `package.json` via `npm install`.
  Scripts: `npm test`, `npm run typecheck`, `npm run provenance-test -- "query"`.
- **Editor:** VS Code with Claude Code.
- **MCP library:** `@modelcontextprotocol/sdk` (v1.x) with `zod` for tool inputs. Use
  `McpServer` + `server.registerTool(name, { description, inputSchema }, handler)` and
  `StdioServerTransport`. stdout is reserved for the protocol, so log to stderr.
- **Web UI (Phase 5):** React + TypeScript, built with Vite.
- **New dependencies:** keep them few. Ask the owner before adding anything heavy.
  Pre-approved: `@modelcontextprotocol/sdk`, `zod`, React and Vite (Phase 5), `docx` (Phase 6, the
  TypeScript replacement for `python-docx`). Use built-ins for HTTP (`fetch`), JSON and tests
  (`node:test`); `node:sqlite` is fine if JSON files become unwieldy.

---

## 3. Current state (already built)

```
provenance/
├── README.md              setup guide for the owner (Windows)
├── SPEC.md                this file
├── package.json           scripts: test, typecheck, provenance-test, provenance-agent
├── tsconfig.json          type checking only (Node runs .ts directly)
├── .env.example           template; owner copies to .env and adds CORE_API_KEY
├── .gitignore             ignores .env, node_modules, data/, workspaces/
├── src/
│   ├── config.ts          SECTION 1  settings; loads CORE_API_KEY from env or .env
│   ├── models.ts          SECTION 2  Source type; normalises CORE records; access label; Chicago citation
│   ├── coreClient.ts      SECTION 3  CoreClient: search(), getWork(), getFullText()
│   │                                  rate limiting, retries on 429/5xx, in-memory cache, friendly errors
│   ├── agentServer.ts     SECTION 4  MCP server "provenance-core" with tools:
│   │                                  search_sources, get_source, read_source_text
│   └── quickTest.ts       SECTION 5  CLI: npm run provenance-test -- "query" [--from Y] [--to Y] [--readable]
└── tests/                 17 offline node:test tests (fake transport; in-memory MCP client)
```

Run tests with: `npm test`

**Live check (2026-10-21):** a keyless search works and maps into Sources. The field mapping in
`models.ts` is still based on third-party documentation and gets verified in Phase 1. Plain
multi-word queries match *any* word (797k hits for "Lowell mill girls strike", mostly Lowell,
Oregon), so query building needs work in Phase 1.

### CORE API v3 facts used so far
- Base URL `https://api.core.ac.uk/v3`. Auth header `Authorization: Bearer <key>`. Keyless works,
  but slower, and `fullText` then returns the placeholder "Not available for public API users".
- `GET /search/works?q=...&limit=...&offset=...` returns `{ totalHits, results: [...] }`.
- `GET /works/{id}` returns one work.
- Query language supports `AND`, `OR`, `NOT`, `"phrases"`, and `yearPublished>=1990`.
- Work fields seen: `id, title, authors[{name}], abstract, yearPublished, publishedDate, doi,
  downloadUrl, sourceFulltextUrls, links[{type,url}], fullText, documentType, publisher, journals,
  language{code,name}, fieldOfStudy`.
- Free tier is rate-limited. A reported figure is about 10 requests per minute. Keep the 1.5 s gap
  between requests.

---

## 4. Build phases

Each phase ends with: tests passing, README updated, and a short plain-language demo for the owner.

### Phase 0: Set up and verify (owner and Claude together)
1. Check `uv --version`. Install it if missing (see §2).
2. Make sure `.env` exists with a real `CORE_API_KEY`. If not, walk the owner through getting one at
   https://core.ac.uk/services/api. **Never ask them to paste the key into chat.** They edit `.env`
   themselves.
3. Run the offline tests, then `uv run provenance-test "Lowell mill girls strike"`.

**Done when:** the live quick test prints real results with "API key: found".

### Phase 1: Harden the CORE connector against real data
1. Write `scripts/inspect_core.py`, which runs 3 to 4 real searches (history topics) and saves raw JSON
   to `data/samples/` (git-ignored). Use it to confirm real field names, `totalHits`, the year query
   syntax, and how often `fullText` and `downloadUrl` are present.
2. Fix `models.py` mappings to match reality. Add a test using a trimmed real sample.
3. Add `document_type` filtering to search (e.g. theses only), if CORE supports it in the query.
4. Add a disk cache (`data/cache/`, keyed by URL, 7-day expiry) so repeat searches don't hit the API.
5. Record a findings note in `docs/core-findings.md`: coverage for 3 history topics (total hits, % with
   full text, % theses). This is product evidence for the owner.

**Done when:** the live searches map cleanly, the tests pass, and the findings note exists.

### Phase 2: Research workspaces (saving work)
A workspace is one research question, stored at `workspaces/<slug>/`:
```
workspace.json   { id, title, question, created, updated, search_log: [{query, filters, date, hits}] }
sources.json     [ Source + { added, notes, relevance: 1-5, status: "candidate"|"included"|"excluded" } ]
themes.json      [ { id, name, summary, source_ids } ]          (Phase 3)
connections.json [ { from, to, kind, evidence, confidence } ]   (Phase 4)
deliverables/    <theme-id>.md                                  (Phase 3)
```
Add MCP tools: `create_workspace`, `list_workspaces`, `open_workspace`, `add_sources(core_ids)`,
`update_source(core_id, status, notes, relevance)`, `list_sources(status?)`.
`search_sources` gets an optional `workspace` argument that logs the search.
All writes are atomic: write to a temp file, then rename.

**Done when:** in Claude Code, the owner can say "start a workspace on the 1840s ten-hour movement,
find 15 sources and save the best 8", and the files appear and survive a restart.

### Phase 3: Themes and narrative deliverables
1. MCP tools: `set_themes(themes)` and `write_deliverable(theme_id, markdown)`, plus
   `get_deliverable`.
2. Deliverable format (Markdown), one per theme:
   - Title and a 2 to 3 sentence overview.
   - Narrative body, where **every factual sentence ends with source markers** like `[S3]` or
     `[S3, S5]`, mapping to `core_id`s via a sources list at the bottom.
   - Callout blocks: `> **How these connect:** ...`, `> **Where sources disagree:** ...`,
     `> **Open question:** ...`
   - A sources list in Chicago notes-bibliography style, the norm in history.
3. A validator (`provenance.validate`) that rejects a deliverable if any marker doesn't match a source
   in the workspace, or a factual paragraph has no markers. `write_deliverable` runs it and returns
   the errors to Claude.
4. Expand the MCP server instructions with this workflow: search → save → read the full text where
   available → themes → deliverables, with quotes as evidence.

**Done when:** a 4-theme workspace produces 4 valid deliverables, and the validator catches a
fabricated marker in a test.

### Phase 4: Connections (the source map)
1. **"Cites" edges:** for sources with a DOI, look them up in OpenAlex
   (`https://api.openalex.org/works/doi:<doi>`, which returns `referenced_works`) and record a `cites`
   edge when both works are in the workspace. OpenAlex is free. A key is optional (query param
   `api_key`, stored in `.env` as `OPENALEX_API_KEY`). Without one there's a small daily budget, and
   single-work lookups are cheap. Add a polite delay and use the cache.
2. **"Builds on" and "disputes" edges:** proposed by Claude through a tool
   `add_connection(from, to, kind, evidence, confidence)`. `evidence` **must** be a short quote or
   precise paraphrase from the citing source's text. If it's missing, the call is rejected.
3. Tool `get_connections()` and a summary (most-connected sources, sources nobody engages with).

**Done when:** the connections are stored with evidence, and OpenAlex lookups work for DOI sources.

### Phase 5: Local web workspace (`uv run provenance-web`)
A local website (standard library `http.server`, or one small framework if the owner approves) at
`http://localhost:8765` that reads the workspace files and shows:
- Left: the research question and theme list.
- Center: the selected deliverable rendered from Markdown. Source markers are clickable and highlight
  the source.
- Right: the **source map**, an SVG graph. Nodes are sources (primary sources tinted differently).
  Edge styles: builds on is solid blue, disputes is dashed red, cites is dotted grey. Clicking a node
  shows the title, connections and access label.
- Bottom: the sources table (#, title and author, type, access label, link).

Visual reference: the owner's concept page `mvp1-provenance.html` (Spectral serif with IBM Plex Sans,
archival paper palette: `--paper #EDEFEA`, `--ink #1D2A30`, `--binding #7B2C3A`,
`--thread #2E5B78`, `--ochre #A9741F`). Ask the owner for that file if it's needed. Read-only in
the MVP. Works at phone width. No external JavaScript libraries are required.

**Done when:** opening the URL shows a real workspace, and clicking markers and nodes works.

### Phase 6: Export
- `export_workspace(format)`: a `.docx` per deliverable, or one combined file, via `python-docx`,
  with headings, callouts as shaded paragraphs, footnote-style source markers and a Chicago
  bibliography. Plus `bibliography.bib` (BibTeX) and `.ris` for Zotero.
- Exports go to `workspaces/<slug>/exports/`.

**Done when:** the Word file opens cleanly and the bibliography imports into Zotero.

---

## 5. Connecting the agent to Claude

The owner previously **declined** an automatic `.mcp.json` file. **Ask before creating one.**
Alternatives:
- Claude Code CLI:
  `claude mcp add --transport stdio provenance-core -- node "C:\Users\abacs\provenance\src\agentServer.ts"`
  (call `node` directly: `npm run` prints a banner to stdout, which breaks the MCP connection).
- Claude Desktop: add the same command to `claude_desktop_config.json` (Settings → Developer →
  Edit Config), then fully restart the app.

After each phase that adds tools, the MCP server must be restarted, or Claude Code reloaded, to pick
them up. Tell the owner when that's needed.

---

## 6. Engineering rules

- **Tests:** standard-library `unittest`, offline by default with fake transports. Live tests only
  run when `PROVENANCE_LIVE_TESTS=1` is set. Every phase adds tests, and all must pass before the
  phase ends.
- **Errors:** tools return `{"error": "<plain-English message and what to do>"}` instead of crashing.
- **Structure:** one module per concern (`core_client`, `openalex_client`, `workspace`, `validate`,
  `export`, `web`). Keep functions small. Type hints throughout.
- **Comments:** a short header in each file explaining in plain English what the section does.
- **Data:** `data/` and `workspaces/` are git-ignored by default. Ask the owner whether they want
  workspaces kept in git.
- **Git:** if the owner wants version control, initialise a repo and commit at the end of each phase,
  with clear messages. Never commit `.env`.
- **Communication:** before large changes, say in 2 to 3 sentences what you'll do. After each phase,
  give a short demo the owner can run, plus anything they need to do by hand.

---

## 7. Success criteria for the MVP

The owner can, in one sitting:
1. Ask Claude a history research question.
2. Get a saved workspace with 8 to 15 relevant open sources, mostly with full text or PDFs.
3. Read 3 to 5 themed deliverables where every claim traces back to a real source.
4. See a source map showing how the sources relate, with evidence for each connection.
5. Export the deliverables to Word, with a bibliography.
6. Note any coverage gaps (topics where CORE returns little) in `docs/core-findings.md`.
