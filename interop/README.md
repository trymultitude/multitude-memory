# Interoperability

The Multitude Memory Format is meant to work alongside other open memory formats rather than compete with them. This folder holds converters and mappings, so memory can move in and out of Multitude without loss.

## Portable Memory (`.mem` bundles)

[Portable Memory](https://github.com/MacPaw/portable-memory) is an open, MIT-licensed format for carrying AI memory between vendors as a `.mem` bundle. `portable-memory.mjs` converts in both directions with no dependencies:

```sh
node interop/portable-memory.mjs to-mem   memory.json  my-memory.mem
node interop/portable-memory.mjs from-mem my-memory.mem memory.json
```

### Multitude to `.mem`

The output is a format 1.1.0 bundle in Canonical JSON with `CHECKSUMS`, per-file digests and a `bundleDigest`, so any conformant reader can verify it. It validates against the Portable Memory JSON Schemas.

| Multitude | `.mem` |
|---|---|
| memory | `episode` with `id` `ep_<id>`, `summary` and `details` set to the text, `sourceType` `note` |
| `created_at` | `eventTime`, `mentionTime` and `ingestionTime` |
| `source.kind` | `claimClass`: `person` → `asserted`, `agent` → `inferred`, `import` → `imported` |
| `source.author` / `agent` / `origin` | `assertedBy`: `user:<author>`, `agent:<agent>` or `system:<origin>`; the author is also listed in `actors` |
| `project` | `contextID` `ctx_p_<id>` (a `context` record under `ctx_workspace`) |
| `scope: private` | `sensitivity: private` |
| `tags` | `categories` |
| `status`, `superseded_by`, `key`, `updated_at` and every `source` field | kept verbatim in `metadata` under the `multitude.` prefix |
| projects and workspace | vendor kinds `multitudeProject` and `multitudeWorkspace`, which conformant readers keep verbatim |

`claimClass` and `assertedBy` follow Portable Memory's draft [RFC-0003](https://github.com/MacPaw/portable-memory/blob/main/Spec/rfcs/0003-provenance-typing.md). Until that lands, readers keep them as foreign episode fields.

### `.mem` to Multitude

- Integrity is checked first: every file's digest and the `bundleDigest` must match, and no path may leave the bundle.
- Tombstones are applied before anything else, so deleted memories never come back.
- Bundles written by this converter come back exactly as they went in.
- Episodes and facts from other implementations become memories. Provenance is read from `assertedBy` where present (`user:` → person, `agent:` or `model:` → agent), and anything else is marked as an import from the bundle's generator. A fact with `supersededBy` or `tValidTo` becomes a superseded memory pointing at its successor. Where several memories would be current for the same key, the newest stays current.

### Limits

- Entities, edges, chunks, procedures and other kinds without a plain-text memory are not imported into Multitude.
- Signed bundles are read without checking the signature; use the Portable Memory SDKs to verify one first.
- Canonical JSON follows the spec, except that integers beyond 2^53 are not exact, which the spec also notes. The converter never writes such numbers.
