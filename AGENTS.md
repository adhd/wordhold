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

Newsletter drain metadata is in Worker D1; every complete parsed body and its queue metadata first land together in a self-contained `email-pending/` R2 record. A small R2 recovery cursor rotates bounded scans across the entire prefix. Allowed rows and a bounded quarantine sample are returned separately, so an unacknowledged quarantine cannot block normal draining. Acknowledgement writes a tiny retained `email-acked/` R2 tombstone before deleting D1 and the pending record, so concurrent recovery cannot resurrect an acknowledged email. Neither remote store is canonical after local acknowledgement.

The Mac drain enforces streaming response caps. A body over the per-message cap remains remote and is recorded in `logs/oversized-worker-bodies.jsonl`; its id is remembered locally so it cannot starve later rows or be downloaded every run. See `docs/operations.md` before retrying one.

Untrusted Shortcut payloads are type/size checked—including serialized JSON size—and their RFC 3339 timestamps canonicalized before raw spooling. The phone uses a capture-only Worker token; it can call capture routes but cannot drain, read bodies, acknowledge, allow senders, or administer. Invalid iCloud files live in `logs/bad-captures/`; invalid/corrupt Worker row metadata is recorded in `logs/bad-worker-captures.jsonl` and remains unacknowledged. Unknown mail quarantine is single-store D1: an atomic trigger keeps 50 rows, complete payloads fit 32 KiB, and new quarantine never writes R2. Accepted senders retain the full R2-backed no-loss path; retained `sender-allowed/` markers are the fallback when D1 authorization lookup fails. Run `worker:sync-senders` after upgrading, and let bounded R2- and D1-driven recovery tombstone/retire legacy quarantines, including rows whose old body object is already missing. Never bypass these boundaries merely to clear a queue.

The launchd daemon is a compiled Bun executable. Runtime assets such as `core/schema.sql` must be bundled into it, not resolved through `import.meta.dir`; `tests/launchd.test.ts` executes the compiled binary against a fresh corpus to enforce this.

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
`docs/setup.md` owns fresh setup; `docs/operations.md` owns lifecycle/recovery;
`docs/integrations.md` owns client behavior; `docs/release-verification.md` owns
generic synthetic evidence; private operator evidence owns live installation
facts. Add comments for non-obvious safety or lifecycle contracts, not
line-by-line narration. Do not duplicate volatile status.

## Agent skills

### Issue tracker

Engineering issues use local Markdown under `.scratch/<feature>/`. See
`docs/agents/issue-tracker.md`.

### Triage labels

The standard five-role label vocabulary is used unchanged. See
`docs/agents/triage-labels.md`.

### Domain docs

Wordhold uses the single-context layout. See `docs/agents/domain.md`.
