# Multitude Memory Format, version 1.0

Status: stable draft, 25 November 2026. Licence: MIT.

The Multitude Memory Format (MMF) is a small, plain JSON format for moving
memory between AI tools. A memory is one durable fact, decision, convention or
preference, written in a plain sentence, plus who wrote it and when. The format
is designed so that any tool can import, export or sync memory without losing
history or authorship.

The key words MUST, SHOULD and MAY are used as described in RFC 2119.

## 1. Document

An MMF document is a UTF-8 JSON object.

| Field         | Type   | Required | Meaning |
|---------------|--------|----------|---------|
| `format`      | string | yes      | Always `"multitude-memory"`. |
| `version`     | string | yes      | `"1.0"` for this spec. Readers MUST accept any `1.x` and ignore fields they do not know. |
| `exported_at` | string | yes      | RFC 3339 timestamp of when the document was written. |
| `workspace`   | object | no       | `{ "name": string, "about"?: string }`. The team or person the memory belongs to. |
| `projects`    | array  | no       | Project objects (section 3). |
| `memories`    | array  | yes      | Memory objects (section 2). May be empty. |

## 2. Memory

| Field           | Type           | Required | Meaning |
|-----------------|----------------|----------|---------|
| `id`            | string         | yes      | Unique within the document. Letters, digits and underscore only (`^\w{1,64}$`). |
| `key`           | string         | yes      | Short topic slug, such as `"deploy-process"`. Memories with the same `key` are versions of one fact. 1 to 120 characters. |
| `text`          | string         | yes      | The memory itself, one or a few plain sentences. 1 to 4000 characters. |
| `scope`         | string         | yes      | `"team"` (shared with everyone in the workspace) or `"private"` (only its author). |
| `status`        | string         | yes      | `"current"` or `"superseded"`. |
| `superseded_by` | string or null | no       | The `id` of the memory that replaced this one. SHOULD be set when `status` is `"superseded"`. |
| `source`        | object         | yes      | Who wrote it (section 2.1). |
| `project`       | string or null | no       | The `id` of a project in `projects`, or null for workspace-wide memory. |
| `created_at`    | string         | yes      | RFC 3339 timestamp. |
| `updated_at`    | string         | yes      | RFC 3339 timestamp, not earlier than `created_at`. |
| `tags`          | array of string| no       | Free-form labels. |

### 2.1 Source

`source` records authorship so people can see and trust where a memory came from.

| Field    | Type   | Required | Meaning |
|----------|--------|----------|---------|
| `kind`   | string | yes      | `"person"` (typed by a human), `"agent"` (written by an AI tool) or `"import"` (brought in from another system). |
| `agent`  | string | no       | Lowercase name of the AI tool, such as `"claude"`, `"chatgpt"`, `"cursor"`, `"claude-code"`. SHOULD be set when `kind` is `"agent"`. |
| `author` | string | no       | Display name of the person the memory belongs to or who approved it. |
| `origin` | string | no       | Where an import came from, such as `"obsidian"` or `"mem"`. |

### 2.2 Rules

1. At most one memory per `key` and `project` pair MAY have `status` `"current"`.
2. Writing a memory with an existing `key` creates a new memory and marks the
   older current one `"superseded"`, with `superseded_by` pointing at the new one.
   History is kept, not overwritten.
3. A memory MUST NOT contain secrets: API keys, passwords, private keys or access
   tokens. Writers SHOULD refuse text that looks like one (see section 5).
4. Readers MUST keep `private` memories private to their author when importing
   into a multi-person system.

## 3. Project

| Field          | Type   | Required | Meaning |
|----------------|--------|----------|---------|
| `id`           | string | yes      | `^\w{1,64}$`. |
| `name`         | string | yes      | Display name. |
| `description`  | string | no       | One line. |
| `instructions` | string | no       | Standing instructions for any AI working on the project. |

## 4. MCP tool contract

A memory server that exposes MMF over the Model Context Protocol SHOULD offer
these three tools with these names, so that agents and prompts work against any
compatible server.

| Tool                 | Annotations                                   | Arguments | Result (`structuredContent`) |
|----------------------|-----------------------------------------------|-----------|------------------------------|
| `multitude_brief`    | `readOnlyHint: true`, `idempotentHint: true`  | `task?: string` | `{ connected: true, brief: string }`: a plain-text summary of the most relevant current memories. |
| `multitude_recall`   | `readOnlyHint: true`, `idempotentHint: true`  | `query: string`, `limit?: number` (1 to 50, default 10) | `{ connected: true, memories: [{ key, text, scope, author }] }`, current memories only. |
| `multitude_remember` | `readOnlyHint: false`, `destructiveHint: false` | `text: string`, `key?: string`, `private?: boolean` | `{ saved: true, id }` or `{ saved: false, error }` with a specific, human-readable reason. |

Each tool SHOULD carry a human-readable `title`. Errors in tool use (for
example, text that is too short or looks like a secret) are returned as a tool
result with `isError: true` and an `error` message, not as a JSON-RPC error.
An unknown tool name returns an error that lists the available tools.

Servers reachable over the network SHOULD use MCP authorization (OAuth 2.1 with
PKCE, protected resource metadata and dynamic client registration) and MAY also
accept a long-lived Bearer key for headless agents.

## 5. Secret patterns

Writers SHOULD refuse to store text matching any of these patterns, and tell the
caller why. The list is a floor, not a ceiling.

- `-----BEGIN [A-Z ]*PRIVATE KEY-----`
- `sk-[A-Za-z0-9_-]{20,}` (OpenAI, Anthropic and OpenRouter style keys)
- `AKIA[0-9A-Z]{16}` (AWS access key id)
- `gh[pousr]_[A-Za-z0-9]{30,}` (GitHub tokens)
- `xox[abprs]-[A-Za-z0-9-]{10,}` (Slack tokens)
- `AIza[0-9A-Za-z_-]{35}` (Google API keys)
- `(sk|rk)_(live|test)_[A-Za-z0-9]{16,}` (Stripe keys)
- `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` (JSON Web Tokens)
- `(password|passwd|pwd)\s*[:=]\s*\S{6,}` (case-insensitive)
- `(password|passwd|passcode)\s+(is|was)\s+\S{6,}` (case-insensitive)
- `[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]{3,}@` (credentials inside a URL, case-insensitive)
- `Bearer\s+[A-Za-z0-9._~+/=-]{20,}` (bearer tokens)

## 6. Versioning

Minor versions (1.1, 1.2) only add optional fields. A breaking change becomes
version 2.0 with a new `version` value. The JSON Schema for this version is
[`memory-format.schema.json`](./memory-format.schema.json).
