#!/usr/bin/env node
// Two-way converter between the Multitude Memory Format (MMF) and the
// Portable Memory `.mem` bundle (https://github.com/MacPaw/portable-memory).
//
//   node interop/portable-memory.mjs to-mem   memory.json  out.mem
//   node interop/portable-memory.mjs from-mem in.mem       memory.json
//
// No dependencies. Mapping and round-trip guarantees are described in
// interop/README.md.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MEM_FORMAT = "1.1.0";
export const SPEC_URL = "https://github.com/MacPaw/portable-memory/blob/main/Spec/portable-memory-spec.md";
const GENERATOR = "multitude-memory/1.0";
const NS = "multitude."; // namespace for metadata keys we own
const WORKSPACE_CTX = "ctx_workspace";
const PROJECT_KIND = "multitudeProject";
const WORKSPACE_KIND = "multitudeWorkspace";

// ---------------------------------------------------------------------------
// Canonical JSON (Portable Memory spec 1.1): keys sorted by code point,
// recursively; no whitespace; `/` unescaped; non-ASCII raw; ECMAScript number
// formatting; absent optionals omitted. JSON.stringify already escapes only
// `"`, `\` and control characters and formats numbers the ECMAScript way, so
// sorting keys is the only extra step.
export function canonicalJSON(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort(byCodePoint)) {
      if (v[k] === undefined) continue;
      out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

function byCodePoint(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Whole-second UTC with a literal Z, as the bundle format requires.
export function wholeSecondUTC(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${ts}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Provenance mapping, aligned with Portable Memory RFC-0003 (claimClass,
// assertedBy). MMF `source.kind` is the producer; `author` is the person the
// memory belongs to or who approved it.
const CLAIM_CLASS = { person: "asserted", agent: "inferred", import: "imported" };

function principal(source) {
  if (source.kind === "person") return source.author ? `user:${source.author}` : undefined;
  if (source.kind === "agent") return source.agent ? `agent:${source.agent}` : undefined;
  if (source.kind === "import") return source.origin ? `system:${source.origin}` : undefined;
  return undefined;
}

// ---------------------------------------------------------------------------
// MMF document -> map of bundle files (relative path -> Buffer)
export function mmfToBundleFiles(doc) {
  const exportedAt = wholeSecondUTC(doc.exported_at);
  const projects = doc.projects ?? [];
  const projectCtx = (id) => `ctx_p_${id}`;

  const contexts = [{ archived: false, createdAt: exportedAt, id: WORKSPACE_CTX, label: doc.workspace?.name ?? "Workspace" }];
  for (const p of projects) contexts.push({ archived: false, createdAt: exportedAt, id: projectCtx(p.id), label: p.name, parentID: WORKSPACE_CTX });

  const episodes = doc.memories.map((m) => {
    const src = m.source ?? { kind: "import" };
    const meta = {
      [`${NS}id`]: m.id,
      [`${NS}key`]: m.key,
      [`${NS}scope`]: m.scope,
      [`${NS}status`]: m.status,
      [`${NS}updated_at`]: m.updated_at,
      [`${NS}source.kind`]: src.kind,
    };
    if (m.superseded_by) meta[`${NS}superseded_by`] = m.superseded_by;
    if (m.project) meta[`${NS}project`] = m.project;
    if (m.tags?.length) meta[`${NS}tags`] = JSON.stringify(m.tags);
    for (const f of ["agent", "author", "origin"]) if (src[f]) meta[`${NS}source.${f}`] = src[f];

    const created = wholeSecondUTC(m.created_at);
    return {
      accessCount: 0,
      actors: src.author ? [src.author] : [],
      assertedBy: principal(src),
      categories: m.tags ?? [],
      claimClass: CLAIM_CLASS[src.kind],
      confidence: 0.7,
      contextID: m.project ? projectCtx(m.project) : WORKSPACE_CTX,
      details: m.text,
      eventTime: created,
      extractionState: "done",
      id: `ep_${m.id}`,
      importance: 0.5,
      ingestionTime: created,
      lifecycleState: m.status === "current" ? "HOT" : "COLD",
      mentionTime: created,
      metadata: meta,
      pinned: false,
      sensitivity: m.scope === "private" ? "private" : "low",
      sourceType: "note",
      summary: m.text,
      vaultRefs: [],
    };
  });
  episodes.sort((a, b) => byCodePoint(a.id, b.id));

  const streams = { "items/context.jsonl": contexts, "items/episode.jsonl": episodes };
  // Projects carry instructions and descriptions the bundle has no native home
  // for, so they travel as a vendor kind, which conformant readers keep verbatim.
  if (projects.length) streams[`items/${PROJECT_KIND}.jsonl`] = projects;
  if (doc.workspace) streams[`items/${WORKSPACE_KIND}.jsonl`] = [doc.workspace];

  const files = {};
  for (const [path, rows] of Object.entries(streams)) {
    if (!rows.length) continue;
    files[path] = Buffer.from(rows.map(canonicalJSON).join("\n") + "\n", "utf8");
  }

  const paths = Object.keys(files).sort(byCodePoint);
  const checksums = Buffer.from(paths.map((p) => `${sha256(files[p])}  ${p}`).join("\n") + "\n", "utf8");
  const times = episodes.map((e) => e.eventTime).sort();
  const counts = {};
  for (const p of paths) counts[p.slice(6, -6)] = files[p].toString("utf8").split("\n").filter(Boolean).length;

  const manifest = {
    bundleDigest: sha256(checksums),
    capabilities: ["ext", "passthrough"],
    conformanceLevel: "L0",
    counts,
    coverage: times.length ? { from: times[0], to: times[times.length - 1] } : undefined,
    createdAt: exportedAt,
    embeddingDim: 0,
    embeddingModel: "",
    embeddingsIncluded: false,
    exportMode: "full",
    files: paths.map((p) => ({ bytes: files[p].length, path: p, sha256: sha256(files[p]) })),
    format: MEM_FORMAT,
    generator: GENERATOR,
    schemaVersion: 0,
    scopes: [...new Set([...contexts.map((c) => c.id), ...episodes.map((e) => e.contextID)])].sort(byCodePoint),
    specURL: SPEC_URL,
  };

  return { ...files, CHECKSUMS: checksums, "manifest.json": Buffer.from(canonicalJSON(manifest), "utf8") };
}

export function writeBundle(doc, dir) {
  const files = mmfToBundleFiles(doc);
  for (const [path, buf] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, buf);
  }
  return Object.keys(files);
}

// ---------------------------------------------------------------------------
// Bundle directory -> MMF document
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function readInside(root, rel) {
  const full = resolve(root, rel);
  const real = realpathSync(full);
  if (real !== realpathSync(root) && !real.startsWith(realpathSync(root) + sep)) throw new Error(`path escapes bundle: ${rel}`);
  const buf = readFileSync(real);
  if (buf.length > MAX_FILE_BYTES) throw new Error(`file too large: ${rel}`);
  return buf;
}

const jsonl = (buf) => buf.toString("utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export function readBundle(dir) {
  const manifest = JSON.parse(readInside(dir, "manifest.json").toString("utf8"));
  // Verify integrity before reading anything else, as the spec requires.
  for (const f of manifest.files ?? []) {
    const buf = readInside(dir, f.path);
    if (sha256(buf) !== f.sha256) throw new Error(`checksum mismatch: ${f.path}`);
  }
  if (manifest.bundleDigest && existsSync(join(dir, "CHECKSUMS"))) {
    if (sha256(readInside(dir, "CHECKSUMS")) !== manifest.bundleDigest) throw new Error("bundleDigest mismatch");
  }
  const listed = new Set((manifest.files ?? []).map((f) => f.path));
  const stream = (kind) => (listed.has(`items/${kind}.jsonl`) ? jsonl(readInside(dir, `items/${kind}.jsonl`)) : []);
  const tombstones = listed.has("audit/tombstones.jsonl") ? jsonl(readInside(dir, "audit/tombstones.jsonl")) : [];
  return { manifest, stream, tombstones };
}

const ID_RE = /^\w{1,64}$/;
function mmfId(raw, used) {
  let id = String(raw).replace(/^ep_|^fact_/, "").replace(/\W/g, "_").slice(0, 64) || "m";
  if (!ID_RE.test(id)) id = "m";
  let out = id, n = 1;
  while (used.has(out)) out = `${id.slice(0, 58)}_${n++}`;
  used.add(out);
  return out;
}

function slug(text) {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return s || "memory";
}

export function bundleToMmf(dir, { now = new Date() } = {}) {
  const { manifest, stream, tombstones } = readBundle(dir);
  // Tombstones apply first, so deleted content cannot come back.
  const dead = new Set(tombstones.map((t) => t.targetID));
  const projectsRaw = stream(PROJECT_KIND);
  const workspace = stream(WORKSPACE_KIND)[0];
  const ctxLabels = new Map(stream("context").map((c) => [c.id, c.label]));

  const used = new Set();
  const memories = [];
  const foreignProjects = new Map();

  for (const ep of stream("episode")) {
    if (dead.has(ep.id) || ep.deletedAt) continue;
    const md = ep.metadata ?? {};
    const text = (ep.summary || ep.details || "").slice(0, 4000);
    if (!text) continue;
    const ours = md[`${NS}id`] !== undefined;
    if (ours) {
      used.add(md[`${NS}id`]);
      const source = { kind: md[`${NS}source.kind`] };
      for (const f of ["agent", "author", "origin"]) if (md[`${NS}source.${f}`]) source[f] = md[`${NS}source.${f}`];
      const m = {
        id: md[`${NS}id`], key: md[`${NS}key`], text: ep.details || ep.summary, scope: md[`${NS}scope`],
        status: md[`${NS}status`], superseded_by: md[`${NS}superseded_by`] ?? null, source,
        project: md[`${NS}project`] ?? null, created_at: ep.eventTime, updated_at: md[`${NS}updated_at`] ?? ep.ingestionTime,
      };
      if (md[`${NS}tags`]) m.tags = JSON.parse(md[`${NS}tags`]);
      memories.push(m);
      continue;
    }
    memories.push(foreignEpisode(ep, text, used, manifest, ctxLabels, foreignProjects));
  }

  // Derived facts from other engines become memories too; supersession is kept.
  const facts = stream("fact").filter((f) => !dead.has(f.id) && !f.prunedAt);
  const factIds = new Map();
  for (const f of facts) factIds.set(f.id, mmfId(f.id, used));
  for (const f of facts) {
    const text = String(f.text || `${f.subject} ${f.predicate} ${f.object}`).slice(0, 4000);
    const superseded = Boolean(f.supersededBy) || Boolean(f.tValidTo);
    memories.push({
      id: factIds.get(f.id),
      key: slug(`${f.subject}-${f.predicate}`),
      text,
      scope: "team",
      status: superseded ? "superseded" : "current",
      superseded_by: f.supersededBy && factIds.has(f.supersededBy) ? factIds.get(f.supersededBy) : null,
      source: provenanceToSource(f, manifest),
      project: null,
      created_at: wholeSecondUTC(f.createdAt),
      updated_at: wholeSecondUTC(f.tValidTo ?? f.createdAt),
    });
  }

  enforceOneCurrentPerKey(memories);

  const doc = { format: "multitude-memory", version: "1.0", exported_at: wholeSecondUTC(now) };
  if (workspace) doc.workspace = workspace;
  const projects = projectsRaw.length ? projectsRaw : [...foreignProjects.values()];
  if (projects.length) doc.projects = projects;
  doc.memories = memories;
  return doc;
}

function provenanceToSource(rec, manifest) {
  const by = typeof rec.assertedBy === "string" ? rec.assertedBy : "";
  const [type, ...rest] = by.split(":");
  const who = rest.join(":");
  if (type === "user" && who) return { kind: "person", author: who };
  if ((type === "agent" || type === "model") && who) return { kind: "agent", agent: who.toLowerCase().split("@")[0] };
  return { kind: "import", origin: rec.metadata?.transfer_source || manifest.generator || "portable-memory" };
}

function foreignEpisode(ep, text, used, manifest, ctxLabels, foreignProjects) {
  let project = null;
  if (ep.contextID && ctxLabels.has(ep.contextID)) {
    project = mmfId(ep.contextID.replace(/^ctx_/, "p_"), new Set());
    if (!foreignProjects.has(project)) foreignProjects.set(project, { id: project, name: ctxLabels.get(ep.contextID) || project });
  }
  const created = wholeSecondUTC(ep.eventTime);
  const ingested = wholeSecondUTC(ep.ingestionTime ?? ep.eventTime);
  const m = {
    id: mmfId(ep.id, used),
    key: slug(text.split(/[.!?]/)[0]),
    text,
    scope: ep.sensitivity === "private" ? "private" : "team",
    status: "current",
    superseded_by: null,
    source: provenanceToSource(ep, manifest),
    project,
    created_at: created,
    updated_at: ingested < created ? created : ingested,
  };
  if (ep.categories?.length) m.tags = ep.categories;
  return m;
}

// MMF allows one current memory per key and project. When a foreign bundle has
// several, the newest stays current and the older ones point at it.
function enforceOneCurrentPerKey(memories) {
  const groups = new Map();
  for (const m of memories) {
    if (m.status !== "current") continue;
    const k = `${m.project ?? ""}\u0000${m.key}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    for (const old of list.slice(1)) Object.assign(old, { status: "superseded", superseded_by: list[0].id });
  }
}

// ---------------------------------------------------------------------------
async function main([cmd, input, output]) {
  if (cmd === "to-mem" && input && output) {
    const doc = JSON.parse(readFileSync(input, "utf8"));
    const { validateDocument } = await import("../spec/validate.mjs");
    const errs = validateDocument(doc);
    if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
    if (existsSync(output) && readdirSync(output).length) { console.error(`${output} exists and is not empty`); process.exit(1); }
    const written = writeBundle(doc, output);
    console.log(`wrote ${output} (${written.length} files, ${doc.memories.length} memories)`);
  } else if (cmd === "from-mem" && input && output) {
    const doc = bundleToMmf(input);
    const { validateDocument } = await import("../spec/validate.mjs");
    const errs = validateDocument(doc);
    if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
    writeFileSync(output, JSON.stringify(doc, null, 2) + "\n");
    console.log(`wrote ${output} (${doc.memories.length} memories)`);
  } else {
    console.error("usage:\n  portable-memory.mjs to-mem   <memory.json> <out.mem>\n  portable-memory.mjs from-mem <in.mem> <memory.json>");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
