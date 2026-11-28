import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJSON, mmfToBundleFiles, writeBundle, bundleToMmf } from "../interop/portable-memory.mjs";
import { validateDocument } from "../spec/validate.mjs";

const example = () => JSON.parse(readFileSync(new URL("../examples/memory.json", import.meta.url), "utf8"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fixture = new URL("./fixtures/portable-memory-sample.mem", import.meta.url).pathname;

test("canonical JSON matches the Portable Memory vectors we rely on", () => {
  // A subset of Conformance/vectors/canonical-json.json (MacPaw/portable-memory, MIT).
  const cases = [
    [{ a: 1.0 }, '{"a":1}'],
    [{ a: 0.7 }, '{"a":0.7}'],
    [{ b: 1, a: { d: 2, c: 3 } }, '{"a":{"c":3,"d":2},"b":1}'],
    [{ s: "a/b" }, '{"s":"a/b"}'],
    [{ s: "café ✓" }, '{"s":"café ✓"}'],
    [{ s: "tab\tnl\n\"q\"\\" }, '{"s":"tab\\tnl\\n\\"q\\"\\\\"}'],
  ];
  for (const [input, want] of cases) assert.equal(canonicalJSON(input), want);
});

test("a Multitude document survives a round trip through a .mem bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmf-"));
  const doc = example();
  writeBundle(doc, dir);
  const back = bundleToMmf(dir, { now: new Date(doc.exported_at) });
  assert.deepEqual(validateDocument(back), []);
  const norm = (d) => d.memories.map((m) => ({ superseded_by: null, project: null, ...m }));
  assert.deepEqual(norm(back), norm(doc));
  assert.deepEqual(back.projects, doc.projects);
  assert.deepEqual(back.workspace, doc.workspace);
});

test("the bundle carries provenance and is integrity-clean", () => {
  const files = mmfToBundleFiles(example());
  const manifest = JSON.parse(files["manifest.json"]);
  assert.equal(manifest.format, "1.1.0");
  for (const f of manifest.files) assert.equal(sha(files[f.path]), f.sha256);
  assert.equal(sha(files.CHECKSUMS), manifest.bundleDigest);
  const eps = files["items/episode.jsonl"].toString().trim().split("\n").map((l) => JSON.parse(l));
  const byId = Object.fromEntries(eps.map((e) => [e.id, e]));
  assert.equal(byId.ep_m_001.claimClass, "asserted");
  assert.equal(byId.ep_m_001.assertedBy, "user:Sam");
  assert.equal(byId.ep_m_002.claimClass, "inferred");
  assert.equal(byId.ep_m_002.assertedBy, "agent:claude-code");
  assert.equal(byId.ep_m_004.claimClass, "imported");
  for (const line of files["items/episode.jsonl"].toString().trim().split("\n")) assert.equal(line, canonicalJSON(JSON.parse(line)));
});

test("output is byte-for-byte deterministic", () => {
  const a = mmfToBundleFiles(example()), b = mmfToBundleFiles(example());
  for (const k of Object.keys(a)) assert.ok(a[k].equals(b[k]), k);
});

test("a bundle from another implementation imports, with tombstones applied first", () => {
  const doc = bundleToMmf(fixture, { now: new Date("2026-11-28T00:00:00Z") });
  assert.deepEqual(validateDocument(doc), []);
  assert.ok(doc.memories.length > 0);
  assert.ok(!doc.memories.some((m) => m.id === "legacy"), "tombstoned episode must not come back");
});

test("a tampered bundle is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmf-"));
  writeBundle(example(), dir);
  const p = join(dir, "items/episode.jsonl");
  writeFileSync(p, readFileSync(p, "utf8").replace("Tuesdays", "Fridays"));
  assert.throws(() => bundleToMmf(dir), /checksum mismatch/);
});

test("a tombstoned memory is not resurrected even if its row is still shipped", () => {
  const dir = mkdtempSync(join(tmpdir(), "mmf-"));
  const files = mmfToBundleFiles(example());
  const tomb = Buffer.from(canonicalJSON({ actor: "user", deletedAt: "2026-11-27T00:00:00Z", id: "tomb_1", op: "delete", targetID: "ep_m_003", targetKind: "episode" }) + "\n");
  const manifest = JSON.parse(files["manifest.json"]);
  manifest.files.push({ bytes: tomb.length, path: "audit/tombstones.jsonl", sha256: sha(tomb) });
  delete manifest.bundleDigest;
  files["audit/tombstones.jsonl"] = tomb;
  files["manifest.json"] = Buffer.from(canonicalJSON(manifest));
  delete files.CHECKSUMS;
  for (const [p, b] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), b);
  }
  const back = bundleToMmf(dir);
  assert.ok(!back.memories.some((m) => m.id === "m_003"));
  assert.equal(back.memories.length, 3);
});
