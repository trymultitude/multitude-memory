#!/usr/bin/env node
// Multitude memory server: a small, dependency-free reference MCP server for the Multitude Memory Format.
// Stores memory in one MMF JSON file on your machine. Speaks MCP over stdio (default) or Streamable HTTP (--http).
//
//   node server/index.mjs                      # stdio, for Claude Desktop, Claude Code, Cursor and others
//   node server/index.mjs --http 8787          # HTTP on 127.0.0.1:8787/mcp
//
// Environment:
//   MULTITUDE_MEMORY_FILE   path to the memory file (default ~/.multitude/memory.json)
//   MULTITUDE_MEMORY_TOKEN  if set, HTTP requests must send Authorization: Bearer <token>
//   MULTITUDE_AGENT         name recorded as the author of saved memories (default: the client name)

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { validateDocument, looksLikeSecret } from "../spec/validate.mjs";

const VERSION = "1.0.0";
const PROTOCOL = "2025-06-18";
const FILE = process.env.MULTITUDE_MEMORY_FILE || join(homedir(), ".multitude", "memory.json");
const TOKEN = process.env.MULTITUDE_MEMORY_TOKEN || "";
const INSTRUCTIONS = "This is the user's shared memory across every AI they use. Call multitude_brief once at the start of a task; save durable learnings with multitude_remember.";

export const TOOLS = [
  {
    name: "multitude_brief",
    title: "Load memory brief",
    annotations: { title: "Load memory brief", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Load what this user and their team already know: project rules, decisions and learnings shared across every AI they use. Call once at the start of a task, passing the task in a few words.",
    inputSchema: { type: "object", properties: { task: { type: "string", description: "The task in a few words." } } },
  },
  {
    name: "multitude_recall",
    title: "Search memory",
    annotations: { title: "Search memory", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: "Search memory for specific facts: a past decision, a convention, a customer, a number. Returns the current version of each matching memory.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 50 } }, required: ["query"] },
  },
  {
    name: "multitude_remember",
    title: "Save to memory",
    annotations: { title: "Save to memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Save one durable learning so the next agent, teammate and chat know it: a decision, a convention, a gotcha, or why something is built this way. One plain sentence. Reusing a `key` replaces the older version and keeps it in history. Never save secrets, keys, tokens or personal data.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, key: { type: "string" }, private: { type: "boolean" } }, required: ["text"] },
  },
];

// ---------- storage ----------
function emptyDoc() {
  return { format: "multitude-memory", version: "1.0", exported_at: new Date().toISOString(), workspace: { name: "My memory" }, projects: [], memories: [] };
}
export function load(file = FILE) {
  if (!existsSync(file)) return emptyDoc();
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const errs = validateDocument(doc);
  if (errs.length) throw new Error(`Memory file ${file} is not valid MMF: ${errs.slice(0, 3).join("; ")}`);
  return doc;
}
function save(doc, file = FILE) {
  doc.exported_at = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------- search ----------
const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
function score(m, ws) {
  const hay = `${m.key} ${m.text}`.toLowerCase();
  let sc = 0;
  for (const w of ws) if (hay.includes(w)) sc += hay.split(w).length - 1 + (m.key.toLowerCase().includes(w) ? 2 : 0);
  return sc;
}
const newer = (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at);
const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "memory";
const sourceName = (s) => String(s || "mcp").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "mcp";

// ---------- tools ----------
export function callTool(name, a = {}, ctx = {}) {
  const file = ctx.file ?? FILE;
  if (name === "multitude_brief") {
    const doc = load(file);
    const cur = doc.memories.filter((m) => m.status === "current");
    const ws = words(a.task ?? "");
    const ranked = cur.map((m) => ({ m, sc: score(m, ws) })).sort((p, q) => q.sc - p.sc || newer(p.m, q.m)).slice(0, 40);
    const lines = [`Workspace: ${doc.workspace?.name ?? "My memory"}`];
    if (doc.workspace?.about) lines.push(`About: ${doc.workspace.about}`);
    if (ranked.length) {
      lines.push("What has been decided and learned (current versions):");
      for (const { m } of ranked) lines.push(`- ${m.text}${m.scope === "private" ? " (private)" : ""}`);
    } else lines.push("No memories saved yet. Save durable learnings with multitude_remember.");
    return { connected: true, brief: lines.join("\n") };
  }
  if (name === "multitude_recall") {
    if (typeof a.query !== "string") return { connected: true, error: "Pass a query: the words to search memory for." };
    const doc = load(file);
    const limit = Math.max(1, Math.min(50, Number(a.limit) || 10));
    const cur = doc.memories.filter((m) => m.status === "current");
    const ws = words(a.query);
    const hits = ws.length ? cur.map((m) => ({ m, sc: score(m, ws) })).filter((x) => x.sc > 0).sort((p, q) => q.sc - p.sc || newer(p.m, q.m)) : cur.sort(newer).map((m) => ({ m }));
    return { connected: true, memories: hits.slice(0, limit).map(({ m }) => ({ key: m.key, text: m.text, scope: m.scope, author: m.source?.author ?? m.source?.agent ?? null })) };
  }
  if (name === "multitude_remember") {
    const text = typeof a.text === "string" ? a.text.trim() : "";
    if (text.length < 3) return { saved: false, error: "Write the thing to remember in one plain sentence." };
    if (text.length > 4000) return { saved: false, error: "That is too long for one memory. Keep it under 4000 characters, or split it into separate facts." };
    if (looksLikeSecret(text)) return { saved: false, error: "That looks like a secret (an API key, token or password), so it was not saved. Store secrets in a password manager or your environment, not in memory." };
    const doc = load(file);
    const key = (typeof a.key === "string" && a.key.trim() ? a.key.trim() : slug(text.split(/\s+/).slice(0, 4).join(" "))).slice(0, 120);
    const now = new Date().toISOString();
    const id = "m_" + randomBytes(10).toString("hex");
    for (const m of doc.memories) if (m.key === key && (m.project ?? null) === null && m.status === "current") { m.status = "superseded"; m.superseded_by = id; m.updated_at = now; }
    const agent = sourceName(process.env.MULTITUDE_AGENT || ctx.client);
    doc.memories.push({ id, key, text, scope: a.private === true ? "private" : "team", status: "current", superseded_by: null, source: { kind: "agent", agent }, project: null, created_at: now, updated_at: now });
    save(doc, file);
    return { saved: true, id };
  }
  return { error: `Unknown tool "${name}". Available tools: ${TOOLS.map((t) => t.name).join(", ")}.` };
}

// ---------- JSON-RPC ----------
export function handle(msg, ctx) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request: expected a JSON-RPC 2.0 object with a method." } };
  if (msg.id === undefined || msg.id === null) return null; // notification
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  try {
    switch (msg.method) {
      case "initialize":
        ctx.client = msg.params?.clientInfo?.name ?? ctx.client;
        return ok({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "multitude-memory", title: "Multitude memory", version: VERSION }, instructions: INSTRUCTIONS });
      case "ping": return ok({});
      case "tools/list": return ok({ tools: TOOLS });
      case "tools/call": {
        const out = callTool(String(msg.params?.name ?? ""), msg.params?.arguments ?? {}, ctx);
        return ok({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: !!out.error });
      }
      default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  } catch (e) {
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e?.message ?? "Server error" } };
  }
}
function handleBody(body, ctx) {
  let msg;
  try { msg = JSON.parse(body); } catch { return { status: 400, out: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not valid JSON." } } }; }
  const res = (Array.isArray(msg) ? msg : [msg]).map((m) => handle(m, ctx)).filter(Boolean);
  if (!res.length) return { status: 202, out: null };
  return { status: 200, out: Array.isArray(msg) ? res : res[0] };
}

// ---------- transports ----------
function stdio() {
  const ctx = { client: "mcp" };
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const { out } = handleBody(line, ctx);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
}

function http(port, host) {
  const sessions = new Map();
  const authed = (h) => {
    if (!TOKEN) return true;
    const got = Buffer.from(String(h ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(TOKEN);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const srv = createServer((req, res) => {
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(body == null ? "" : JSON.stringify(body)); };
    if (new URL(req.url, "http://x").pathname !== "/mcp") return send(404, { error: "Not found. The MCP endpoint is /mcp." });
    if (req.method === "DELETE") return send(204, null);
    if (req.method !== "POST") return send(405, { error: "Use POST." }, { allow: "POST, DELETE" });
    if (!authed(req.headers.authorization)) return send(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Send Authorization: Bearer <MULTITUDE_MEMORY_TOKEN>." } }, { "www-authenticate": 'Bearer realm="multitude-memory"' });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      const sid = req.headers["mcp-session-id"] || randomBytes(8).toString("hex");
      const ctx = sessions.get(sid) ?? { client: "mcp" };
      sessions.set(sid, ctx);
      const { status, out } = handleBody(body, ctx);
      send(status, out, { "mcp-session-id": sid });
    });
  });
  srv.listen(port, host, () => process.stderr.write(`multitude-memory listening on http://${host}:${port}/mcp (file: ${FILE})\n`));
  return srv;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const i = process.argv.indexOf("--http");
  if (i > -1) http(Number(process.argv[i + 1]) || 8787, process.env.HOST || "127.0.0.1");
  else stdio();
}
