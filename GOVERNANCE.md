# Governance

The Multitude Memory Format is meant to be implemented by anyone, including companies that compete with Multitude. This document sets out how it is run, so you can rely on it.

## Our commitments

1. **The format stays open.** The specification, JSON Schema, validator, reference server and conformance suite are MIT licensed and will stay MIT licensed. We will not relicense them, add field-of-use restrictions or require an agreement to implement them.
2. **No royalties, no certification fees.** You do not need our permission, a licence or a paid programme to implement the format, import it, export it or say your product is compatible.
3. **The format never locks your data in.** Any compliant document can be read by any compliant tool. We will not add fields that only Multitude's hosted service can read in order to make leaving harder.
4. **Versioned and backwards compatible.** Minor versions (1.1, 1.2) only add optional fields, and readers must ignore fields they do not know. Breaking changes need a new major version, published alongside the old one, with at least 12 months' notice before Multitude's own products stop writing the old version.
5. **Changes are made in public.** Every change to the specification is proposed and discussed in a public issue or pull request in this repository before it is merged.

## How changes are made

1. **Open an issue** describing the change, the problem it solves and how it affects existing documents.
2. **Discussion stays open for at least 14 days** for any change to the specification (typo and clarity fixes excepted), so implementers have time to respond.
3. **A pull request** updates the specification, the JSON Schema, the validator and the conformance suite together, with tests.
4. **Maintainers merge** once concerns raised in the discussion have been answered. If a change is declined, the reason is written in the issue.
5. **Releases are tagged** (`spec-v1.1` and so on) with a changelog entry describing what changed and why.

## Maintainers

The specification is currently maintained by the Multitude team. As other organisations ship implementations, we intend to invite their maintainers to review specification changes, and to move the specification to a neutral foundation if a suitable one exists and there is demand.

## Scope of the reference server

The reference server in `server/` exists to make the format concrete and to test the conformance suite against. It is single-user and local only (see the README). It is not a production, multi-tenant memory service, and improvements to it never change what the format requires.

## Contact

Questions about governance: hello@trymultitude.com. Security reports: security@trymultitude.com.
