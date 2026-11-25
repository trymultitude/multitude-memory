#!/usr/bin/env node
// Conformance test for Multitude memory servers (spec/memory-format.md, section 4) and MMF documents.
//
//   node conformance/run.mjs --stdio "node server/index.mjs"
//   node conformance/run.mjs --url http://127.0.0.1:8787/mcp [--token <bearer>]
//   node conformance/run.mjs --file my-export.json
//
// The server tests write a few memories (keys start with "conformance-"). Point it at a test workspace.
// Exits 0 when every MUST check passes. SHOULD checks are reported as warnings.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { validateDocument } from "../spec/validate.mjs";

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
let pass = 0, fail = 0, warn = 0;
const check = (level, name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else if (level === "SHOULD") { warn++; console.log(`  warn  ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};

// ---------- transports ----------
function stdioClient(cmd) {
  const child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); }
  });
  return {
    send: (msg) => new Promise((res, rej) => {
      if (msg.id == null) { child.stdin.write(JSON.stringify(msg) + "\n"); return res(null); }
      const t = setTimeout(() => rej(new Error(`no reply to ${msg.method} within 10 s`)), 10000);
      waiting.set(msg.id, (m) => { clearTimeout(t); res(m); });
      child.stdin.write(JSON.stringify(msg) + "\n");
    }),
    raw: null,
    close: () => child.kill(),
  };
}
function httpClient(url, token) {
  let sid = null;
  const post = async (body, auth = true) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (sid) headers["mcp-session-id"] = sid;
    const r = await fetch(url, { method: "POST", headers, body });
    if (r.headers.get("mcp-session-id")) sid = r.headers.get("mcp-session-id");
    const text = await r.text();
    let data = null;
    if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      data = line ? JSON.parse(line.slice(5)) : null;
    } else if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { status: r.status, headers: r.headers, data };
  };
  return { send: async (msg) => (await post(JSON.stringify(msg))).data, raw: post, close: () => {} };
}

// ---------- server checks ----------
async function serverSuite(c, isHttp) {
  let id = 1;
  const rpc = (method, params) => c.send({ jsonrpc: "2.0", id: id++, method, params });
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args }))?.result;

  console.log("Lifecycle");
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conformance", version: "1.0.0" } });
  check("MUST", "initialize returns a result", !!init?.result);
  check("MUST", "initialize declares the tools capability", !!init?.result?.capabilities?.tools);
  check("MUST", "initialize returns serverInfo.name", typeof init?.result?.serverInfo?.name === "string");
  check("MUST", "initialize returns a protocolVersion", typeof init?.result?.protocolVersion === "string");
  await c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const ping = await rpc("ping", {});
  check("MUST", "ping returns an empty result", ping?.result && Object.keys(ping.result).length === 0);

  console.log("Tools");
  const list = (await rpc("tools/list", {}))?.result?.tools ?? [];
  const tool = (n) => list.find((t) => t.name === n);
  for (const n of ["multitude_brief", "multitude_recall", "multitude_remember"]) {
    const t = tool(n);
    check("MUST", `${n} is listed`, !!t);
    check("MUST", `${n} has an object inputSchema`, t?.inputSchema?.type === "object");
    check("SHOULD", `${n} has a title`, typeof (t?.title ?? t?.annotations?.title) === "string");
  }
  check("MUST", "multitude_recall requires query", (tool("multitude_recall")?.inputSchema?.required ?? []).includes("query"));
  check("MUST", "multitude_remember requires text", (tool("multitude_remember")?.inputSchema?.required ?? []).includes("text"));
  check("MUST", "multitude_brief is marked readOnlyHint true", tool("multitude_brief")?.annotations?.readOnlyHint === true);
  check("MUST", "multitude_recall is marked readOnlyHint true", tool("multitude_recall")?.annotations?.readOnlyHint === true);
  check("MUST", "multitude_remember is marked readOnlyHint false", tool("multitude_remember")?.annotations?.readOnlyHint === false);
  check("MUST", "multitude_remember is marked destructiveHint false", tool("multitude_remember")?.annotations?.destructiveHint === false);

  console.log("Memory round trip");
  const tag = Math.random().toString(36).slice(2, 8);
  const key = `conformance-${tag}`;
  const r1 = await call("multitude_remember", { text: `Conformance check ${tag}: the staging database is called pelican.`, key });
  check("MUST", "remember saves and returns an id", r1?.structuredContent?.saved === true && typeof r1?.structuredContent?.id === "string", JSON.stringify(r1?.structuredContent));
  const rec1 = await call("multitude_recall", { query: `pelican ${tag}` });
  const hits1 = rec1?.structuredContent?.memories ?? [];
  check("MUST", "recall finds the saved memory", hits1.some((m) => m.text.includes(tag) && m.text.includes("pelican")));
  check("MUST", "recall returns key, text and scope", hits1.every((m) => typeof m.key === "string" && typeof m.text === "string" && typeof m.scope === "string"));
  check("MUST", "recall result also has text content", Array.isArray(rec1?.content) && rec1.content[0]?.type === "text");
  const r2 = await call("multitude_remember", { text: `Conformance check ${tag}: the staging database is called heron now.`, key });
  check("MUST", "remember with the same key saves a new version", r2?.structuredContent?.saved === true);
  const rec2 = (await call("multitude_recall", { query: `staging database ${tag}`, limit: 50 }))?.structuredContent?.memories ?? [];
  const mine = rec2.filter((m) => m.text.includes(tag));
  check("MUST", "recall returns only the current version of a key", mine.length === 1 && mine[0].text.includes("heron"), JSON.stringify(mine));
  const brief = await call("multitude_brief", { task: `check staging database ${tag}` });
  check("MUST", "brief returns text", typeof brief?.structuredContent?.brief === "string");
  check("MUST", "brief includes the current memory", (brief?.structuredContent?.brief ?? "").includes("heron"));
  check("MUST", "brief leaves out the superseded version", !(brief?.structuredContent?.brief ?? "").includes(`${tag}: the staging database is called pelican`));
  const lim = (await call("multitude_recall", { query: "", limit: 1 }))?.structuredContent?.memories ?? [];
  check("MUST", "recall honours limit", lim.length <= 1);

  console.log("Errors");
  const short = await call("multitude_remember", { text: "x" });
  check("MUST", "too-short text is refused with isError and a message", short?.isError === true && typeof short?.structuredContent?.error === "string");
  const fake = ["sk", "conformance", "0000000000000000000000000000"].join("-");
  const secret = await call("multitude_remember", { text: `Our key is ${fake}` });
  check("SHOULD", "text that looks like a secret is refused", secret?.isError === true && secret?.structuredContent?.saved === false);
  const unknown = await call("no_such_tool", {});
  check("MUST", "unknown tool returns isError", unknown?.isError === true);
  check("SHOULD", "unknown tool error lists the available tools", /multitude_recall/.test(unknown?.structuredContent?.error ?? unknown?.content?.[0]?.text ?? ""));
  const bad = await rpc("no/such/method", {});
  check("MUST", "unknown method returns JSON-RPC error -32601", bad?.error?.code === -32601);

  if (isHttp) {
    console.log("HTTP");
    const parse = await c.raw("{not json");
    check("MUST", "malformed JSON returns 400 with -32700", parse.status === 400 && parse.data?.error?.code === -32700);
    const note = await c.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    check("MUST", "a notification returns 202", note.status === 202);
    if (opt("--token") || process.env.MCP_TOKEN) {
      const anon = await c.raw(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/list" }), false);
      check("MUST", "a request without a token returns 401", anon.status === 401);
      check("SHOULD", "the 401 carries a WWW-Authenticate header", !!anon.headers.get("www-authenticate"));
    }
  }
}

// ---------- main ----------
async function main() {
  const file = opt("--file"), url = opt("--url"), cmd = opt("--stdio");
  if (!file && !url && !cmd) {
    console.log('Usage: run.mjs --stdio "<command>" | --url <mcp url> [--token <bearer>] | --file <export.json>');
    process.exit(2);
  }
  if (file) {
    console.log(`Memory format: ${file}`);
    let doc = null;
    try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { check("MUST", "file is valid JSON", false, e.message); }
    if (doc) {
      const errs = validateDocument(doc);
      check("MUST", "document matches the Multitude Memory Format 1.x", errs.length === 0, errs.slice(0, 5).join("; "));
    }
  }
  if (cmd || url) {
    const c = cmd ? stdioClient(cmd) : httpClient(url, opt("--token") ?? process.env.MCP_TOKEN);
    console.log(`Server: ${cmd ?? url}`);
    try { await serverSuite(c, !!url); } catch (e) { check("MUST", "server responds", false, e.message); }
    c.close();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
  process.exit(fail ? 1 : 0);
}
main();
