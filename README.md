# Multitude memory

**One memory for every AI you use.**

This repository holds the open pieces behind [Multitude](https://trymultitude.com)'s shared memory:

- **[The Multitude Memory Format](spec/memory-format.md)**: a small JSON format for moving memory between AI tools without losing history or authorship. It comes with a [JSON Schema](spec/memory-format.schema.json) and a dependency-free [validator](spec/validate.mjs).
- **[A reference MCP memory server](server/index.mjs)**: one file with no dependencies. It keeps your memory in a local file and gives any MCP client three tools: `multitude_brief`, `multitude_recall` and `multitude_remember`.
- **[A conformance test](conformance/run.mjs)**: checks that any memory server, or any export file, follows the spec.
- **[Converters to other open formats](interop/README.md)**: two-way conversion with [Portable Memory](https://github.com/MacPaw/portable-memory) `.mem` bundles, so your memory is never tied to one format.

Everything here is MIT licensed and will stay that way: see [GOVERNANCE.md](GOVERNANCE.md) for our commitments and how the format changes. You can run the server yourself, build your own server against the spec, or use the hosted version at `https://app.trymultitude.com/mcp`, which adds sign-in, teams, sync across devices and one chat with every model.

## Why

Every AI tool now has its own memory, and none of them share it. What you tell ChatGPT, Claude Code doesn't know. What Cursor learns about your codebase, Claude doesn't know. A memory is only worth something if it follows you, so the format should be open and the data should be yours to export.

## Quick start (self-hosted, local)

> **The reference server is single-user and local only.** It keeps one person's memory in one JSON file, ranks results by keyword and recency, and does not separate one user's private memories from another's. Use it to try the format, to test your own implementation, or for your own memory on your own machine. It is not a multi-tenant service: anything shared between people needs real sign-in, per-user access checks and transactional storage, which the hosted version adds.

You need Node.js 18 or newer. No install step is needed.

```sh
git clone https://github.com/trymultitude/multitude-memory
cd multitude-memory
npm test   # unit tests plus the conformance suite against the reference server
```

Memory is stored in `~/.multitude/memory.json` (set `MULTITUDE_MEMORY_FILE` to change it). The file is plain Multitude Memory Format, so you can read it, back it up or move it to another tool.

### Claude Desktop, Cursor, Windsurf and other MCP clients

Add this to the client's MCP settings (for Claude Desktop: Settings > Developer > Edit Config; for Cursor: `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "multitude-memory": {
      "command": "node",
      "args": ["/absolute/path/to/multitude-memory/server/index.mjs"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add multitude-memory -- node /absolute/path/to/multitude-memory/server/index.mjs
```

### Over HTTP

```sh
MULTITUDE_MEMORY_TOKEN=choose-a-long-random-string node server/index.mjs --http 8787
```

The server listens on `http://127.0.0.1:8787/mcp` and requires `Authorization: Bearer <token>` when `MULTITUDE_MEMORY_TOKEN` is set. It binds to localhost only; put it behind TLS and your own authentication before exposing it anywhere else.

## Hosted version

To share one memory across ChatGPT, Claude, Gemini, Cursor and Claude Code without running anything, connect to:

```
https://app.trymultitude.com/mcp
```

It uses standard MCP sign-in (OAuth), so clients that support it open a Multitude sign-in and consent screen. Headless agents can use a memory key from Settings > Connected AIs instead. Setup steps for each client are in the [docs](https://app.trymultitude.com/docs#connect), and the [privacy policy](https://app.trymultitude.com/privacy) covers what is stored.

## The tools

| Tool | What it does | Changes data? |
|------|--------------|---------------|
| `multitude_brief` | Loads a short brief of the most relevant current memories for a task. Call it once at the start. | No (read-only) |
| `multitude_recall` | Searches memory for a specific fact, decision or convention. Returns current versions only. | No (read-only) |
| `multitude_remember` | Saves one durable learning in a plain sentence. Reusing a `key` replaces the older version and keeps it in history. | Adds a memory, never deletes |

The server refuses to store text that looks like an API key, token, private key or password (see [section 5 of the spec](spec/memory-format.md#5-secret-patterns)).

## Conformance

Test any memory server or export file against the spec:

```sh
node conformance/run.mjs --stdio "node server/index.mjs"
node conformance/run.mjs --url https://your-server.example/mcp --token <bearer>
node conformance/run.mjs --file my-export.json
```

The server checks write a few memories with keys starting `conformance-`, so point it at a test workspace. It exits non-zero if any required check fails, and lists recommended checks as warnings.

## Publishing to the MCP Registry

`server.json` describes the hosted server for the [official MCP Registry](https://github.com/modelcontextprotocol/registry). The `Publish to MCP Registry` workflow publishes it on every `v*` tag using GitHub OIDC, so no stored secrets are needed.

## Security

- No telemetry. The reference server makes no network calls; it reads and writes one local file.
- The memory file is written with `0600` permissions.
- CI runs [gitleaks](https://github.com/gitleaks/gitleaks) on every push.
- Report vulnerabilities to security@trymultitude.com rather than in a public issue.

## Contributing

Issues and pull requests are welcome. Changes to the format go through the spec first: open an issue describing the change and why. Minor versions only add optional fields, so existing files keep working. The full process is in [GOVERNANCE.md](GOVERNANCE.md).

## Licence

[MIT](LICENSE)
