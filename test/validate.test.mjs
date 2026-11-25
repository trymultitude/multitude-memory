import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateDocument, looksLikeSecret } from "../spec/validate.mjs";

const example = () => JSON.parse(readFileSync(new URL("../examples/memory.json", import.meta.url), "utf8"));

test("the example document is valid", () => {
  assert.deepEqual(validateDocument(example()), []);
});

test("two current memories for one key are rejected", () => {
  const d = example();
  d.memories[0].status = "current";
  assert.match(validateDocument(d).join("\n"), /second current memory/);
});

test("unknown project references are rejected", () => {
  const d = example();
  d.memories[2].project = "p_missing";
  assert.match(validateDocument(d).join("\n"), /must reference a project id/);
});

test("bad ids, scopes and dates are rejected", () => {
  const d = example();
  Object.assign(d.memories[1], { id: "has-hyphen", scope: "everyone", created_at: "yesterday" });
  const errs = validateDocument(d).join("\n");
  assert.match(errs, /\.id/);
  assert.match(errs, /\.scope/);
  assert.match(errs, /\.created_at/);
});

test("secret patterns are caught and normal text is not", () => {
  const fakeKey = ["sk", "proj", "A".repeat(24)].join("-");
  assert.ok(looksLikeSecret(`the key is ${fakeKey}`));
  assert.ok(looksLikeSecret("password: hunter2hunter2"));
  assert.ok(!looksLikeSecret("We deploy on Tuesdays after the test suite passes."));
  assert.ok(!looksLikeSecret("Ask Sam before changing the password policy."));
});
