# JevNews

An independent, Hacker News–style reader with shared article analysis, seven public reading presets, and private reading rules. Built for Cloudflare Workers, D1, R2, Queues and a small SQLite Durable Object.

**Status: first executable implementation, not a deployed service.** Local tests, a Wrangler dry run, and local workerd integration have been exercised. Real HN synchronization, TypeSafe billing, Workers AI compilation quality, production performance and HN pixel parity still need staging validation. See [implementation status](docs/implementation-status.md).

## Run locally

Requires Node 22.16+ (Node 24 recommended), npm and Python 3. The dependency versions and complete lockfile are committed.

```sh
npm ci
npm run db:local
npm run dev
# http://localhost:8787
```

The local config emulates D1/R2/Queues/DO. It does not bind a remote AI service, and synchronization and model calls are disabled. A blank news list is intentional, not an API error. Local registration works only on a loopback hostname; the production configuration never bypasses Turnstile.

For a **read-only preview with fictional, explicitly marked data**, without Cloudflare credentials:

```sh
npm run preview
# http://127.0.0.1:4173
```

## Validate

```sh
npm run typecheck
npm test
npm run test:db
npm run build        # dry-run only; creates dist/, does not deploy
npm run test:runtime # local workerd + isolated D1/R2/Queue/DO smoke checks
```

`npm run test:runtime` uses port 8799, creates temporary local storage, and removes it after execution. Tests mock external HN/TypeSafe responses; no paid provider calls or production credentials are required.

## Included

- Compact server-rendered HN-like lists, More/snapshot pagination, source links, bounded comment trees and public HN profiles.
- Balanced, Engineering, AI & Agents, Systems & Databases, Show & Build, Products & Startups, Curiosity.
- Own username/password accounts, one-time recovery codes, private rules, saved/hidden state and account deletion.
- Natural-language compiler adapter with explicit review, a strictly validated rule DSL and bounded private semantic evaluations.
- Durable HN discovery/task ledger, configurable DO alarm, Cron watchdog, queues, shared content-hash analysis and R2 feed snapshots.
- TypeSafe `systemone` adapter using typed `noul`, `score`, `choice` answers; no fabricated model results when disabled.
- CSRF/Origin checks, Turnstile, rate limits, owner checks, password hashing, source-fetch boundaries and budget reservations.

HN votes, replies and submissions open HN. JevNews does not accept HN credentials or claim to write to HN's read-only public API.

## Deploy deliberately

Follow [deployment and operations](docs/deployment.md). Replace the D1 placeholder, create private R2/Queues resources, configure lifecycle rules, install secrets and Turnstile, and validate in staging before enabling any model calls. `npm run deploy` is an explicit remote write and may incur Cloudflare charges.

Initial packaging is **one Worker deployment with separate modules**, not three independently deployed Workers. It can later be split without changing the product. No server, PostgreSQL, Redis or vector database is needed.

## Documentation

| Document | Purpose |
| --- | --- |
| [Product requirements](docs/product-requirements.md) | Confirmed product contract and current delivery boundaries |
| [Cloudflare design](docs/architecture/cloudflare-design.md) | Actual components, data flow, security and failure handling |
| [Database migration](migrations/0001_initial.sql) | Authoritative executable schema |
| [Data synchronization](docs/architecture/data-sync-and-reuse.md) | DO, incremental discovery, source content and snapshots |
| [Reuse, budget and DO](docs/architecture/reuse-cost-and-durable-objects.md) | Final implementation decisions and illustrative costs |
| [Deployment](docs/deployment.md) | Configuration, secrets, staging, rollback and operations |
| [Implementation status](docs/implementation-status.md) | What was tested and what remains unverified |
| [Security](SECURITY.md) | Boundaries and responsible handling |

Apache-2.0 for this repository's original code. No entire HN clone was imported. See [third-party notices](THIRD_PARTY_NOTICES.md).
