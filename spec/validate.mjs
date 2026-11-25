// Dependency-free validator for the Multitude Memory Format 1.x, plus the secret patterns from section 5.
// Usage: import { validateDocument, looksLikeSecret } from "./validate.mjs";

export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
];

export function looksLikeSecret(text) {
  return SECRET_PATTERNS.some((p) => p.test(String(text)));
}

const ID = /^\w{1,64}$/;
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s));
const isStr = (s) => typeof s === "string";

// Returns a list of problems; an empty list means the document is valid.
export function validateDocument(doc) {
  const errs = [];
  const err = (path, msg) => errs.push(`${path}: ${msg}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["$: must be a JSON object"];
  if (doc.format !== "multitude-memory") err("$.format", 'must be "multitude-memory"');
  if (!isStr(doc.version) || !/^1\.\d+$/.test(doc.version)) err("$.version", 'must be "1.x"');
  if (!isDate(doc.exported_at)) err("$.exported_at", "must be an RFC 3339 timestamp");
  if (doc.workspace !== undefined && (typeof doc.workspace !== "object" || !isStr(doc.workspace?.name))) err("$.workspace", "must be an object with a name");

  const projectIds = new Set();
  if (doc.projects !== undefined) {
    if (!Array.isArray(doc.projects)) err("$.projects", "must be an array");
    else doc.projects.forEach((p, i) => {
      const at = `$.projects[${i}]`;
      if (!p || typeof p !== "object") return err(at, "must be an object");
      if (!isStr(p.id) || !ID.test(p.id)) err(`${at}.id`, "must match ^\\w{1,64}$");
      else if (projectIds.has(p.id)) err(`${at}.id`, "duplicate id");
      else projectIds.add(p.id);
      if (!isStr(p.name) || !p.name) err(`${at}.name`, "is required");
    });
  }

  if (!Array.isArray(doc.memories)) { err("$.memories", "must be an array"); return errs; }
  const ids = new Set(), current = new Map();
  doc.memories.forEach((m, i) => {
    const at = `$.memories[${i}]`;
    if (!m || typeof m !== "object") return err(at, "must be an object");
    if (!isStr(m.id) || !ID.test(m.id)) err(`${at}.id`, "must match ^\\w{1,64}$");
    else if (ids.has(m.id)) err(`${at}.id`, "duplicate id");
    else ids.add(m.id);
    if (!isStr(m.key) || m.key.length < 1 || m.key.length > 120) err(`${at}.key`, "must be 1 to 120 characters");
    if (!isStr(m.text) || m.text.length < 1 || m.text.length > 4000) err(`${at}.text`, "must be 1 to 4000 characters");
    else if (looksLikeSecret(m.text)) err(`${at}.text`, "looks like a secret (section 5)");
    if (m.scope !== "team" && m.scope !== "private") err(`${at}.scope`, 'must be "team" or "private"');
    if (m.status !== "current" && m.status !== "superseded") err(`${at}.status`, 'must be "current" or "superseded"');
    if (!m.source || typeof m.source !== "object" || !["person", "agent", "import"].includes(m.source.kind)) err(`${at}.source.kind`, 'must be "person", "agent" or "import"');
    else if (m.source.agent !== undefined && (!isStr(m.source.agent) || !/^[a-z0-9_-]{1,40}$/.test(m.source.agent))) err(`${at}.source.agent`, "must be a lowercase tool name");
    if (m.project != null && !projectIds.has(m.project)) err(`${at}.project`, "must reference a project id in $.projects");
    if (!isDate(m.created_at)) err(`${at}.created_at`, "must be an RFC 3339 timestamp");
    if (!isDate(m.updated_at)) err(`${at}.updated_at`, "must be an RFC 3339 timestamp");
    else if (isDate(m.created_at) && Date.parse(m.updated_at) < Date.parse(m.created_at)) err(`${at}.updated_at`, "is earlier than created_at");
    if (m.tags !== undefined && (!Array.isArray(m.tags) || !m.tags.every(isStr))) err(`${at}.tags`, "must be an array of strings");
    if (m.status === "current" && isStr(m.key)) {
      const k = `${m.project ?? ""}\u0000${m.key}`;
      if (current.has(k)) err(`${at}`, `second current memory for key "${m.key}" (rule 2.2.1)`);
      current.set(k, true);
    }
  });
  doc.memories.forEach((m, i) => {
    if (m?.superseded_by != null && !ids.has(m.superseded_by)) errs.push(`$.memories[${i}].superseded_by: must reference a memory id`);
  });
  return errs;
}
