# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue for anything that could put someone's memory at risk.

Include what you found, the steps or a small test that reproduces it, and which version or commit you tested. We aim to acknowledge reports within three working days and to agree a disclosure date with you once a fix is ready.

## Scope

- The reference server (`server/index.mjs`), the validator (`spec/validate.mjs`), the conformance suite and the format specification.
- The hosted service at `app.trymultitude.com` is covered by the same reporting route. Please test it only with your own account and data, and do not run automated scanners against it.

## What the reference server does and does not protect

The reference server is single-user and local. It stores memory in one file readable only by your user account, refuses obvious secrets (spec section 5), requires a bearer token in HTTP mode, and rejects requests whose `Host` or browser `Origin` is not local. It does not separate one person's memories from another's, and it cannot stop an AI client that has been prompt-injected from saving or reading memory through the tools you have granted it. The brief marks memories as notes from named tools so a model can weigh them, but treat anything saved by a tool you do not trust with care.
