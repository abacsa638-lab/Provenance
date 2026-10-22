# Provenance

A research tool for history and humanities graduate students. Give it a research question and it
finds open-access sources (papers, theses, dissertations, digitised primary sources), groups them into
themes, and shows how they connect: who cites, builds on or disputes whom. Every claim traces back to
a real source.

It's a research tool, not a writing tool. See [SPEC.md](SPEC.md) for the full plan.

## Setup (Windows, PowerShell)

1. **Install Node.js 24 or newer** (once):
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   Then restart VS Code.
2. **Install the project's packages** from this folder:
   ```powershell
   npm install
   ```
3. **Add your CORE API key** (optional but recommended: faster, and full text only works with a key):
   - Get a free key at https://core.ac.uk/services/api
   - Copy `.env.example` to `.env`, then paste your key after `CORE_API_KEY=`
   - Never paste the key into a chat, and never commit `.env` (git ignores it already).

## Try it

```powershell
npm test                                                     # offline tests
npm run provenance-test -- "Lowell mill girls strike"        # live search
npm run provenance-test -- "ten-hour movement" --from 1980 --readable
```

The quick test prints `API key: found` when your key is picked up.

Search tip: CORE matches any of your words unless you use quotes or AND, e.g.
`"mill girls" AND Lowell AND strike`.

## Connect it to Claude Code

Already set up on this computer (private to this project). To set it up again, run once in PowerShell:

```powershell
claude mcp add --transport stdio provenance-core -- "C:\Program Files\nodejs\node.exe" "C:\Users\abacs\provenance\src\agentServer.ts"
```

The full path to `node.exe` matters: VS Code may not see Node on its PATH until Windows restarts.
Then reload Claude Code. Claude gets three tools: `search_sources`, `get_source`, `read_source_text`.
After any update that adds tools, reload Claude Code again.

## What's in here

| File | What it does |
| --- | --- |
| `src/config.ts` | Settings; reads `CORE_API_KEY` from the environment or `.env` |
| `src/models.ts` | Turns CORE records into tidy sources; access labels; Chicago citations |
| `src/coreClient.ts` | Talks to CORE: pacing, retries, caching, friendly errors |
| `src/agentServer.ts` | The MCP server Claude uses (`provenance-core`) |
| `src/quickTest.ts` | The terminal search command |
| `tests/` | Offline tests (no internet or key needed) |
