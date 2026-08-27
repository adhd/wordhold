# Wordhold Agent Contract

Wordhold is a public-source, local-first reading archive for one owner: each
saved item becomes canonical Markdown plus a rebuildable SQLite index. Agents
are first-class users of this data. This repository is product-code authority;
each installation creates a separate private data Git repository. Paths below
are relative to the configured `PAPERTRAIL_ROOT` unless identified as product
source.

Wordhold was called Papertrail through version 0.4. The first Wordhold release
retains `PAPERTRAIL_*`, `papertrail.config.json`, `papertrail.db*`, `pt_*` ids,
the `papertrail` MCP key, and other persisted machine identifiers for safe
in-place upgrades. Treat them as compatibility contracts; never rename or move
an existing corpus merely to match the product name.

## Layout

```
items/YYYY/MM/<slug>-<id>.md   canonical item files, partitioned by captured_at
papertrail.db                  SQLite index, rebuildable, never authoritative
inbox/raw/                     ignored durable spool; complete captures awaiting ack
inbox/merges/                  ignored write-ahead intents for recoverable two-file merges
inbox/writer-intents/          ignored per-writer ownership until its git commit succeeds
logs/resurfacing.jsonl         append-only journal of resurfacing events
logs/                          daemon run logs
<product source>/core/         shared library (types, store, db, urls, imessage)
<product source>/daemon/       capture daemon: adapters, extraction, outputs
<product source>/worker/       optional Worker source (deployed separately)
<product source>/agent/        enrichment job + product-owned prompt/schema
<product source>/docs/         setup, operations, architecture, integrations
```

Detailed ingestion, newsletter, Worker, Shortcut, launchd, and recovery contracts
belong in `docs/architecture.md`; operational recovery procedures belong in
`docs/operations.md`. Read the owning section before changing one of those
boundaries, and never bypass a queue, quarantine, writer intent, or
acknowledgement rule merely to make a run appear successful.

## Reading

- **Search:** use the structured CLI or MCP contract; FTS covers title, extracted body, highlights, and captured context. Agents must not use raw SQL as their product integration.
- **Time scoping:** translate user-relative periods into explicit ISO `from`/`to` bounds before calling structured search.
- **“What did I read about X last month?”** call `search_items` with exact month bounds, then `get_item` only for relevant hits. Cite stable item id, date, title, and source URL, and state body-unavailable/no-match limits.
- **An item's full content:** read its markdown file (`md_path` column). Frontmatter carries id, url, title, sources, status, tags, summary, and serializer-owned `highlight_count`. Body is the extracted article text. A counted terminal `## Highlights` section lists highlights, each marked `[manual]` or `[ai]` with an id anchor comment; never infer metadata from a marker-shaped passage in the source body.
- **Capture:** `bun run pt capture '<URL or text>'` atomically queues for the daemon and prints a machine-readable receipt. For an explicit highlight or URL choice, pass one `{input,intent,url?,title?,capturedAt?,idempotencyKey?}` JSON object to `bun run pt capture --json` on stdin. This is the trusted shell/Hermes interface and requires no secret. A `queued` receipt is not yet an archived item.
- **CLI reads:** `bun run pt recent`, `bun run pt search <terms>`, `bun run pt show <id>`, `bun run pt health`. Health reports exact run/success timestamps, setup errors, schedule-aware staleness, never-run source/jobs, and retained raw/intent work. Its exit status is zero only for healthy aggregate state; do not treat printed output or a missing row as healthy without checking it.
- **Outputs:** `bun run digest` sends the weekly report. `bun run resurface` sends old highlights; route a negative iMessage reply containing its displayed highlight id through `bun run resurface --reply 'skip hl_...'`.
- The db and files should agree; if they disagree, the markdown file is right, and `bun run pt rebuild` rebuilds the db from files + journal. Rebuild is all-or-nothing: malformed canonical input leaves the last complete index readable and must be repaired from source evidence, never guessed. If it finds an interrupted canonical merge, it finishes and commits that exact recovery before clearing the writer intent.
- A malformed `inbox/raw/*.json` file is recoverable private evidence, not permission to stop unrelated valid work or delete/acknowledge the bad record. Correct and requeue only after reviewing the preserved bytes; see `docs/operations.md`.
- **Recovery set:** a coherent Git commit holds the runnable canonical corpus; SQLite and health are rebuildable/resettable. Ignored queue/intent state changes the recovery point, while credentials and macOS/device configuration must be re-created separately. `bun run verify:local-restore` is same-Mac mechanics only; read the installation's private off-machine evidence before claiming Mac-loss recovery.
- **Architecture and recovery boundaries:** read `docs/architecture.md` before changing ingestion, acknowledgement, canonical writes, or enrichment ownership.
- **Outbound reads:** canonical and tracking URLs must remain public HTTP(S); production resolves once, pins the connection to the vetted address with original Host/SNI, and manually revalidates every redirect. Treat `forbidden_url` and `redirect_forbidden` as safety outcomes, not extraction bugs.
- **Operate or install:** use `docs/setup.md` and `docs/operations.md`; do not guess at device, Cloudflare, FDA, or launchd state.

## Writing rules (binding)

1. **Manual highlights and extracted body text are immutable to automated writers.** Never edit, reorder, or delete a `[manual]` highlight or the body. If you fix anything, fix AI-owned fields only.
   Captured contexts in `capture_contexts` are also user/source evidence: capture ingestion may append a deduplicated context, but enrichment and maintenance writers never rewrite or remove one.
2. Automated writers may: append `[ai]` highlights, set `summary`, `tags`, `status` in frontmatter, and mirror those to the db. Nothing else.
3. Write the markdown file first, then the db row. Ids are minted once (`core/ids.ts`) and never regenerated; a highlight keeps its id even if its text is corrected.
4. Merging duplicate items unions their highlights and sources; never replace a highlight set.
5. Enrichment never invents content: no summary or highlights for an item whose body is below the configured minimum (`enrichment.minBodyChars`). Flag it instead.
   Inference runs outside the canonical writer lock. Clean items precede retries; three parse/runner failures retire a poison item as `fetch_failed`, and the job has a ten-minute wall-clock budget.
6. Tags come from the private data root's `agent/tags.md`. Adding a tag requires adding its one-line definition there. Consolidate near-duplicates when noticed.
7. Resurfacing state changes go through the journal (`logs/resurfacing.jsonl`), one JSON line per event; the db table is derived.
8. Commit to git after a write batch. The daemon and the enrichment job make separate commits so their diffs stay separately revertable.
   Runtime writers must use `core/writer.ts`: claim before mutation, refuse pre-existing dirty paths, and clear an intent only after its scoped commit succeeds.
9. Never print secrets (`.env`, worker secret) into logs or chat.
10. Keep documentation current in the same coherent change. `README.md` owns
    the product boundary and docs map; `docs/architecture.md` owns invariants;
    `docs/how-it-works.md` owns the day-to-day user model; `docs/setup.md` owns
    fresh setup; `docs/operations.md` owns lifecycle/recovery;
    `docs/integrations.md` owns client behavior; `docs/source-provenance.md` owns
    the public-source/history boundary; `docs/release-verification.md` owns
    generic synthetic evidence; `SECURITY.md` owns vulnerability reporting;
    accepted architectural decisions live under `docs/decisions/`; private
    operator evidence owns live installation facts. Add comments for non-obvious
    safety or lifecycle contracts, not line-by-line narration. Do not duplicate
    volatile status.

## Engineering map

Use this map to find the owning code, documentation, and first focused tests.
Also run adjacent tests when a change crosses a boundary.

| Subsystem | Owning code | Owning docs | Focused tests |
| --- | --- | --- | --- |
| Canonical storage, SQLite, Git, writer intents, restore proof | `core/store.ts`, `core/db.ts`, `core/git.ts`, `core/writer.ts`, `core/atomic.ts`, `core/schema.sql`, `scripts/verify-local-restore.ts` | `docs/architecture.md`, `docs/operations.md` | `tests/core-store.test.ts`, `tests/core-rebuild.test.ts`, `tests/core-git.test.ts`, `tests/core-atomic.test.ts`, `tests/writer.test.ts`, `tests/restore-rehearsal.test.ts` |
| Capture transaction, adapters, extraction, outbound fetch | `core/capture-*.ts`, `daemon/main.ts`, `daemon/raw-spool.ts`, `daemon/adapters/`, `daemon/extract.ts`, `daemon/public-fetch.ts` | `docs/architecture.md`, `docs/how-it-works.md` | `tests/capture-request.test.ts`, `tests/raw-spool.test.ts`, `tests/daemon-integration.test.ts`, `tests/adapters-*.test.ts`, `tests/extract-*.test.ts`, `tests/public-fetch.test.ts` |
| Structured query, CLI, MCP, doctor, health | `core/query.ts`, `core/doctor.ts`, `core/health.ts`, `cli/pt.ts`, `cli/wordhold.ts`, `mcp/` | `docs/architecture.md`, `docs/integrations.md`, `docs/operations.md` | `tests/cli.test.ts`, `tests/mcp-integration.test.ts`, `tests/doctor.test.ts`, `tests/health.test.ts`, `tests/recent-pagination.test.ts` |
| Enrichment, digest, resurfacing | `agent/`, `daemon/digest.ts`, `daemon/resurface.ts`, `core/journal.ts`, `scripts/verify-live-digest.ts` | `docs/architecture.md`, `docs/operations.md` | `tests/enrichment.test.ts`, `tests/digest.test.ts`, `tests/resurface.test.ts`, `tests/live-verification.test.ts` |
| Worker and newsletter | `worker/src/`, `worker/migrations/`, `daemon/adapters/worker-inbox.ts`, `daemon/email-item.ts` | `docs/architecture.md`, `docs/setup.md`, `docs/operations.md` | `tests/worker-*.test.ts`, `tests/newsletter-e2e.test.ts`, `tests/adapters-worker.test.ts`, `tests/email-item.test.ts`, `tests/allow-sender.test.ts` |
| Installation, lifecycle, launchd, client/phone integrations | `cli/wordhold.ts`, `core/installation.ts`, `core/shortcut-*.ts`, `scripts/init-local.ts`, `scripts/install-*.ts`, `scripts/lifecycle.ts`, `scripts/configure-iphone.ts`, `scripts/verify-online-shortcut.ts` | `docs/setup.md`, `docs/operations.md`, `docs/integrations.md` | `tests/guided-setup.test.ts`, `tests/lifecycle-safety.test.ts`, `tests/launchd.test.ts`, `tests/agent-integrations.test.ts`, `tests/iphone-*.test.ts`, `tests/shortcut-*.test.ts` |
| Public source, privacy, artifact and release boundary | `core/artifact.ts`, `scripts/build-distribution.ts`, `scripts/package-distribution.ts`, `scripts/release-candidate.ts`, `scripts/verify-source-boundary.ts`, `scripts/verify-release-download.ts`, `scripts/verify-third-party-licenses.ts` | `docs/source-provenance.md`, `docs/release-verification.md`, `SECURITY.md` | `tests/source-boundary.test.ts`, `tests/privacy-*.test.ts`, `tests/distribution.test.ts`, `tests/release-*.test.ts`, `tests/docs.test.ts`, `tests/third-party-licenses.test.ts` |

## Safe development workflow

1. Confirm the product-source repository root and inspect `git status --short`.
   Preserve unrelated changes. Read `README.md`, this file, the owning document
   above, and applicable decisions under `docs/decisions/` before editing.
2. Never point development or test commands at a live `PAPERTRAIL_ROOT`, an
   installed application root, or a private Worker deployment. Do not run live
   sends, provider deployments, device automation, migrations, or corpus
   recovery as part of ordinary source validation. Tests must use their isolated
   temporary roots and fake external seams.
3. Use the Bun version and executable digest pinned in `README.md`, then install
   with `bun install --frozen-lockfile --ignore-scripts`.
4. Run the focused tests from the map while iterating. Add a behavior test for a
   changed contract, make the smallest coherent implementation, and keep the
   owning documentation current.
5. Before handoff, run validation proportionate to the change. The normal broad
   gate is `bun test`, `bun run typecheck`, and `bun run worker:typecheck` when
   Worker code or shared types are affected. Also run `bun run compile` for
   daemon, packaging, runtime-asset, or release changes; run
   `bun run verify:source` for source-boundary, privacy, packaging, or release
   changes. Report any skipped gate and why.

`tests/v01-upgrade.test.ts` is a separate retained-artifact compatibility gate.
It skips without `PAPERTRAIL_V01_ARCHIVE`; an ordinary green `bun test` does not
prove it. Follow `docs/release-verification.md` for release work rather than
claiming that gate from the normal development suite.

## Agent skills

### Issue tracker

Engineering issues use local Markdown under `.scratch/<feature>/`. See
`docs/agents/issue-tracker.md`.

### Triage labels

The standard five-role label vocabulary is used unchanged. See
`docs/agents/triage-labels.md`.

### Domain docs

Wordhold uses the single-context layout. See `docs/agents/domain.md`.
