# Architecture and durability contracts

This document describes the implemented system. `README.md` owns the supported product boundary; private project prompts are not part of a distribution.

## Product source and private state

Public product source and each user's private authority are separate roots. The sanitized artifact contains allowlisted code, generic documentation/templates, and target-specific compiled local entry points; it contains no corpus, runtime state, installation evidence, credentials, or source Git history. Binaries are built from the completed sanitized tree, not a private data checkout. Its manifest records source revision/dirty state, product version, build platform/architecture/Bun version, executable inventory, and hashes for the exact allowed file set. Internal hashes and the release receipt bind exact bytes within the canonical GitHub channel; ad-hoc signatures do not authenticate a publisher. The private data root contains canonical `items/`, tag vocabulary, journals, ignored config/credentials/queues/index/logs, and its own Git repository.

Wordhold was called Papertrail through version 0.4. Version 0.5 changes the
human-facing product and preferred command while intentionally retaining an
existing installation's storage, receipt, LaunchAgent, MCP-registration,
Keychain, Worker, and Shortcut namespaces. Those names cross durable or
externally owned boundaries. A fresh optional Worker may use the generic
`wordhold-worker` deployment template; it never runs beside a retained
Papertrail deployment for the same installation.
An in-place update adds the `wordhold` command but does not move the corpus,
replace stable ids, create a sibling data root, or duplicate external clients.

`PAPERTRAIL_APP_ROOT` identifies product assets and `PAPERTRAIL_ROOT` identifies private state. Program updates stage and verify a complete release, then atomically change only the active version pointer. The install receipt pins its data root; program and data roots cannot contain or alias one another. Default uninstall removes program pointers/releases while preserving the data root. A private development repository may co-locate code and data for backward compatibility, but it—or any clone, bundle, branch, or full-history export—is never the distribution artifact.

New initialization writes every optional capability explicitly disabled. A legacy populated config without capability flags retains its prior behavior. Enabled-but-incomplete configuration is `unconfigured` and does not start that adapter/job; disabled, unconfigured, never-run, healthy, stale, and failed are distinct health states.

## Agent boundary

`core/query.ts` and `core/doctor.ts` own versioned structured behavior. Human/JSON CLI and the stdio MCP adapter reuse it. MCP adds schemas, authority annotations, and concise summaries only; it never gains a network listener, model, alternate store/writer, maintenance tools, or arbitrary file access. Corpus content is inert untrusted evidence. Explicit capture queues through the same raw-spool transaction and cannot be represented as archived before the daemon commit.

## Data authority

`items/YYYY/MM/*.md` is canonical. Each file owns a stable item id, normalized canonical URL plus aliases, source union, status, extracted body, AI-owned summary/tags, captured contexts, and anchored manual/AI highlights. A captured context has a stable `cx_…` id, `shared_text` or `note` kind, source, timestamp, text, and an optional hash of the caller's idempotency identity. It is FTS-queryable but is neither extracted body nor manual attention. Automated code never rewrites a non-empty body, removes a manual highlight, or rewrites/removes captured context.

Current writers include an explicit `highlight_count` in frontmatter. The parser consumes a terminal human-readable `## Highlights` section only when that serializer-owned count is nonzero and exactly matches; count zero leaves marker-shaped article text in the body. Legacy files without the field retain their old parse rule and gain the explicit count on their next canonical write. This prevents source text from forging manual attention metadata.

`papertrail.db` is a disposable compatibility-named index. It contains item metadata, URL aliases, highlights, FTS5 content (title, body, highlights, and captured contexts), source health, and folded resurfacing state. `wordhold rebuild` recreates all corpus-derived tables from Markdown and the append-only resurfacing journal. Corpus-table clearing, parsing, repopulation, and journal folding share one SQLite transaction. A parse failure rolls the transaction back, preserving the prior complete index for explicitly degraded reads; the bad canonical path is reported without its contents. Markdown still wins, and the daemon refuses new canonical/upstream mutation until a rebuild succeeds.

The launchd daemon target is a compiled Bun executable. The SQL schema is imported as bundled text so the binary does not depend on source-relative `import.meta.dir`, which points inside Bun's virtual filesystem after compilation. Every scheduled job receives both `PAPERTRAIL_ROOT` for private state and `PAPERTRAIL_APP_ROOT` for versioned product assets; compiled jobs must never resolve packaged prompts from `/$bunfs`. Scheduling preserves the stable daemon inode when packaged bytes are unchanged so a no-op update does not needlessly invalidate Full Disk Access. The release test executes the daemon against a fresh temporary corpus and verifies the derived database is initialized.

## Capture transaction

1. **Admission and source isolation.** The daemon validates canonical authority,
   then scans each local raw-spool file independently before adapters pull.
   Malformed raw bytes stay in place and produce bounded `raw_spool` health that
   names only the path and reason; independent valid raw records and adapters
   continue. Each adapter pulls independently. A hard adapter failure updates
   only that source's health and attempts an iMessage alert. `pt capture` writes
   atomically into `inbox/raw/`, where the ordinary daemon transaction discovers
   it on the next pass.

   Untrusted Shortcut data is validated before raw spooling. Saves require a
   public HTTP(S) URL; highlights and notes require non-empty text; optional
   fields must have the documented types and coordinated byte limits; and
   supplied timestamps must be RFC 3339 date-times canonicalized to UTC. iCloud
   input is read from one open descriptor to at most 40 KiB. Transient reads and
   fresh parse failures stay upstream for retry. Settled invalid files move
   intact to `logs/bad-captures/` through a streaming, fsynced cross-volume
   fallback that never buffers hostile evidence whole. A transient quarantine
   move defers without blocking later work. Rejections degrade source health and
   remain visible in iPhone status.

   Invalid Worker requests return 400 before enqueueing. The Worker bounds both
   the raw request and the exact persisted payload, including canonical timestamp
   and idempotency identity, so a 200 response cannot become an undrainable
   oversize row. A corrupt or oversized historical row is returned as bounded
   quarantine metadata, logged once, and left unacknowledged while later valid
   rows continue. Canonical storage independently canonicalizes capture
   timestamps before deriving a partition path.

2. **Durable local spool.** Before conversion, fetch, or extraction, the daemon
   atomically persists the complete capture as
   `inbox/raw/<stable-key>.json`.

3. **Writer ownership.** Daemon, enrichment, and resurfacing serialize writes
   through `core/writer.ts`. Before touching a path, the active writer durably
   claims it in `inbox/writer-intents/`. A path already dirty without that
   writer's intent is refused as human or other-writer work. Interrupted intents
   let the same writer recover and commit its own complete atomic files on
   restart.

4. **Canonical mutation.** Ingestion atomically writes canonical Markdown, then
   updates SQLite. URL aliases and delivery identities prevent restart replay
   from minting another item. Caller idempotency identity remains separate from
   the opaque upstream acknowledgement id: both survive in the ignored raw
   spool, while canonical Markdown stores only the caller-identity hash.
   URL-less newsletters include the Worker delivery id, or capture timestamp
   fallback, in their private dedupe identity so recurring same-title issues
   remain distinct.

5. **Merge recovery.** A canonical-URL merge writes an `inbox/merges/` intent
   before replacing the winner and deleting the loser. Any rebuild completes
   that deterministic file merge first, so death at either file boundary cannot
   leave an unrebuildable duplicate URL. Runtime startup and `wordhold rebuild`
   do this under the daemon writer intent; rebuild commits the exact recovered
   paths before clearing it. Manual provenance wins same-text AI collisions and
   keeps the manual highlight id.

6. **Scoped commit.** The daemon commits exactly the changed paths in its writer
   intent. Every product-owned Git command pins the corpus working directory,
   clears inherited `GIT_*` state, ignores user and system configuration,
   disables hooks, and uses explicit pathspecs. The corpus repository's local
   identity configuration remains in force. A newly created path merged away
   before its first commit is filtered as transient instead of being passed to
   Git as a nonexistent path; tracked deletions remain staged normally. The
   daemon never rescans and absorbs the enrichment writer's namespace or
   unrelated staged or working-tree changes.

7. **Acknowledgement.** Only after the scoped commit succeeds does the adapter
   acknowledge or delete upstream state. The raw-spool record is removed after
   acknowledgement. Source health becomes green only after all boundaries
   succeed. Commit or acknowledgement failure marks the affected source and
   daemon job while retaining recoverable state; a crash at any earlier boundary
   leaves enough state for idempotent replay.

### Worker credential boundary

The Worker has two authentication roles. `SECRET` is the daemon/admin credential
and retains all `/v1/` operations. `CAPTURE_SECRET` is accepted only by
`POST /v1/save`, `/v1/highlight`, and `/v1/capture`; every
body/drain/ack/allow/sender-administration request with it returns 403. The admin
secret remains a valid capture credential for controlled migration, but is never
placed on the phone.

### Online Shortcut invariants

- **Artifact and credential state:** the qualified 0.4.0 compatibility **Save to
  Papertrail — Online** artifact is one immutable Apple-signed export. Its shared
  bytes contain two empty Text actions and two import questions with no defaults,
  so they contain neither a deployment origin nor a credential. Import
  personalizes the installed copy with the full HTTPS `/v1/save` endpoint and
  `CAPTURE_SECRET`. That installed Shortcut, and any Apple-synced copy, is
  credential-bearing device state. The Mac retains only the credential's
  Keychain reference under separate `iphoneOnline` state and cannot inspect or
  update the phone copy.

- **Input and receipt:** the graph accepts Text, URL, and Safari Web Page Share
  Sheet input only to extract URLs. Static verification covers those input
  classes; bounded device qualification covers one Safari page only, does not
  prove a new installation, and does not live-qualify other Share Sheet
  providers. The graph requires exactly one URL, posts JSON `{url}` with the
  capture-only bearer token, reads response key `id`, and shows success only when
  that value begins with `in_`. It has no file action, iCloud fallback, title,
  selected-text preservation, timestamp, or caller idempotency key. Repeating a
  successful gesture can create another D1 row; canonical URL identity makes
  later Mac ingestion converge on one item.

- **Remote queue and local commit:** the Worker owns credential enforcement,
  public-URL and payload validation, and the durable D1 insert. It returns the
  minimal `{id: "in_…"}` receipt only after that insert succeeds. `Accepted by
  Papertrail: in_…` proves a remote queue boundary, not extraction or canonical
  storage. The Mac daemon later pulls with the admin credential, atomically
  spools, fetches and extracts, writes Markdown and SQLite, creates its scoped
  Git commit, then acknowledges the Worker row. The phone and Mac may be
  separated in time; automatic draining requires the Worker inbox capability
  and installed scheduling.

- **Evidence classes:** offer metadata records the exact generic artifact digest
  and its `owner_qualified` release status. Local `approval_required`,
  `approved`, `update_available`, or `repair_required` state records only the
  relationship among the active artifact, offered digest, and human acceptance.
  `repair_required` requires setup, re-import or update, and fresh approval.
  Separately, `state: blocked` with `worker: drain_unconfigured` means the
  resolved local Worker drain does not match the online client. `liveDevice`
  stays `unknown`; Mac-side status cannot prove import, Share Sheet visibility,
  personalized values, or execution. A product update may refresh the offered
  digest but cannot edit the phone. Changed bytes require re-import and fresh
  approval, and any semantic graph change reopens qualification.

### Legacy iCloud recovery boundary

The withdrawn 0.3.5–0.3.7 local-file Shortcut artifacts were not imported into
this public Git or release history and are not supported inputs. Retained adapter
compatibility exists only to recover preserved legacy evidence: the exact
build-marked 0.3.7 filename and envelope use the complete filename as
acknowledgement and fallback idempotency identity; legacy `.json` files remain a
separate compatibility path; and unrelated `.txt` files are ignored. Never
import, run, or resurrect a withdrawn workflow. Preserve legacy queue and
rejected-file evidence byte-exactly and follow [historical local-file
recovery](operations.md#legacy-icloud-recovery). See [source
provenance](source-provenance.md) for the public-history boundary.

The daemon rebuilds SQLite from canonical files at process startup. This heals the narrow crash window where Markdown replacement succeeded but the derived database update did not. Before pulling sources, each pass also retries at most ten oldest URL items still in `captured` with attempts remaining. Upstream delivery is not required for retry; each failed attempt is canonical state, and `maxFetchAttempts` remains the terminal bound.

All stored and fetched reading URLs are HTTP(S). Literal local, private, link-local, and reserved targets are rejected before storage or network access. Production extraction and newsletter tracking resolution resolve hostnames once, reject the destination if any answer is non-public, and connect the transport to one exact vetted IP while preserving the original HTTP Host and TLS server name. The transport therefore cannot perform a second attacker-controlled DNS lookup. Redirects are followed manually and each destination is independently resolved, validated, and pinned. Injected test transports do not perform real DNS unless the test supplies a resolver. A page's canonical-link metadata goes through the same scheme and literal-host policy before it can replace the requested URL.

## Newsletter transaction

1. **Accepted-sender write-ahead.** Cloudflare Email Routing invokes
   `worker/src/email.ts`; attachments are discarded. Before D1 is touched,
   parsed text or HTML and complete queue metadata are stored together in R2 at
   `email-pending/<inbox-id>.json`. The D1 inbox row is only a drain index: it
   contains the R2 key, never a truncated body. If the isolate dies or D1 is
   unavailable after the R2 write, a later authenticated drain promotes the
   pending record into D1.

   Each first-page drain scans at most 200 R2 records and promotes at most five
   missing rows. A durable cursor records the next scan position and wraps at the
   end, so indexed prefix records cannot starve later recovery; cursor pages do
   not repeat recovery work. Promotion checks D1 first, avoiding repeated body
   downloads, and checks `email-acked/<inbox-id>` around recovery and again after
   insertion. A tombstone appearing in the final race window causes immediate
   row retraction.

2. **Sender authorization.** Authorization uses Cloudflare's SMTP envelope
   `message.from`, normalized to lowercase. A differing RFC `From` header is
   retained only as bounded `headerFrom` display metadata and can never satisfy
   the allowlist. A spoofed header therefore remains quarantined under its actual
   envelope identity.

   Each allow operation writes a retained `sender-allowed/` R2 marker before D1.
   Production checks D1 first and that marker second, so D1 lookup failure still
   recognizes known senders. An indeterminate unmarked sender fails the Worker
   invocation instead of being destructively misclassified. `bun run
   worker:sync-senders` creates markers for older allowlist rows.

3. **Unknown-sender quarantine.** Authorization is checked before parsing
   unknown mail. Quarantine is deliberately single-store: D1 keeps small
   messages inline, and an `AFTER INSERT` trigger atomically retains only the 50
   newest rows even under concurrent delivery. Unknown raw input is read to at
   most 1 MiB. It is retained inline only when its complete serialized payload
   fits 32 KiB; larger mail becomes bounded metadata and must be resent after
   approval. New quarantine never writes R2, so D1 outage or eviction cannot
   orphan a quarantine body. Accepted senders retain the full R2
   write-ahead/no-loss path.

   During upgrade, bounded recovery converts old R2-backed quarantines to
   `legacy_quarantine_requires_resend` metadata in D1, writes a tombstone,
   deletes the old object, and only then permits pruning. A separate rotating D1
   sweep finds legacy rows whose old object is already missing. Allowlisting
   verifies any legacy body before release. These boundaries prevent
   eviction/re-promotion churn and permanent `/body` failures.

4. **Acknowledgement ordering.** Acknowledgement writes the small retained R2
   tombstone first, then deletes D1 and the pending object. Tombstones are not
   deleted: deletion cannot be safely ordered against promotion already in
   flight. An interruption may leave a row visible for retry or a harmless
   tombstone and pending object, but recovery cannot recreate an acknowledged
   row.

5. **Bounded Mac drain.** The Worker pages allowed rows independently from a
   bounded quarantine sample, so an unacknowledged sender backlog cannot block
   the allowed cursor. The Mac adapter applies a 30-second deadline to headers
   and complete response-body consumption, a 2 MiB metadata-response cap, and a
   streaming 64 MiB newsletter-hydration cap. Each run also stops at 200 accepted
   captures, 20 pages, or 64 MiB of hydrated newsletter responses.

   A single body that crosses the cap is cancelled, recorded locally, left
   unacknowledged, and skipped on later runs so valid rows behind it continue.
   An aggregate-budget stop only defers the current and later rows; the next
   scheduled pass continues after earlier accepted rows are committed and
   removed.

6. **Tracking and commit boundary.** After local raw spooling and before the
   first immutable canonical-body write, the daemon follows a bounded set of
   known newsletter tracking redirectors. Every redirect remains subject to the
   outbound URL policy above. Resolution, timeout, or policy failure leaves the
   original link intact. The daemon acknowledges ids only through its commit
   boundary; acknowledgement removes the D1 row and deterministic pending body
   only after establishing the retained R2 tombstone.

7. **Email-to-item semantics.** List-Post, HTML canonical, or view-in-browser
   evidence identifies a newsletter or article body, which remains immutable. A
   plain or forwarded message with exactly one non-tracking public URL becomes a
   URL save: the message is captured context and the page fetch becomes body.
   Multiple URLs are not guessed. A short URL-less plain-text message becomes a
   note; a substantive plain-text newsletter becomes body under the configured
   minimum-body gate. Sender authorization always uses only the SMTP envelope
   identity.

## Enrichment ownership

`agent/enrich.ts` selects clean `has_body` items before retry candidates, then oldest first, with a batch cap of 20 and a ten-minute job budget. Bodies below the configured minimum are marked honestly without invoking the agent. Each item uses an ephemeral, read-only, schema-constrained Codex CLI run in an empty temporary working directory under the signed-in subscription; no standalone API key is inherited. Each subprocess is killed after two minutes, and one malformed reply gets one schema nudge.

Parse and runner failures are counted in canonical `last_error`; the third failed nightly attempt changes the item to `fetch_failed`, so poison work cannot spend forever or starve later items. Inference does not hold the cross-process writer lock. Only verified mutation and its scoped commit run in a short enrichment writer session, allowing capture to continue while Codex is thinking. Code independently rejects non-verbatim proposed highlights. Summary, tags, status, and accepted AI highlights become visible in one atomic Markdown replacement, then SQLite is updated.

The tag vocabulary is `agent/tags.md`. A new tag requires a definition and is journaled in `logs/new-tags.jsonl` for later digest review.

## Digest and resurfacing

The weekly digest is deterministic: it reports the previous seven days of arrivals, source counts, manual-first highlights, tags shared by multiple items, failed/unfetched titles and errors, source health/staleness, and new tag definitions. It does not ask an agent to manufacture a pattern narrative.

Source health distinguishes success, failure/setup-needed, stale, and never-run state through one shared classifier used by both CLI and digest. The daemon records absent configured paths/URLs as degraded notes rather than empty success, and the daemon job is its own five-minute heartbeat. Enrichment parse/runner failures are degraded outcomes; resurfacing becomes healthy only after its required journal commit. Enrichment, digest, and resurfacing record their own scheduled-job outcomes using thresholds matching the five-minute, daily, and weekly launchd schedules. Event-driven `email:<sender>` rows are not treated as scheduler heartbeats. `pt health` also treats raw captures or writer intents older than 15 minutes as stuck and exits nonzero for any aggregate degradation; fresh in-flight work is not a failure.

## Recovery model

- **Required private data snapshot:** a valid data-repository commit containing canonical `items/`, `agent/tags.md`, and the deliberately tracked `logs/resurfacing.jsonl` and `logs/new-tags.jsonl` journals. Runnable recovery also needs the exact sanitized program release, or a newer release proven compatible with that snapshot.
- **Derived/resettable:** `papertrail.db*` is rebuilt from authority. `source_health` is useful operational history but is neither canonical nor reconstructed and may reset after loss.
- **Recovery-point evidence:** ignored `inbox/raw/`, `inbox/merges/`, and `inbox/writer-intents/` can represent unacknowledged or uncommitted work. A Git-only snapshot excludes them. Acknowledged work after the snapshot commit may therefore be lost; unacknowledged Worker/iCloud captures may still exist upstream, but local-only raw captures survive only when the chosen backup includes them.
- **Re-created/protected separately:** `.env`, populated config, Keychain credentials, the personalized online Shortcut, launchd jobs, Full Disk Access, Messages automation, preserved legacy iCloud Shortcut/folder state, and Cloudflare account resources. Provider recovery features are not counted without a demonstrated restore.

`verify:local-restore` is a maintainer harness run from a pinned product-source
checkout with Bun and its locked dependencies. It clones one completed data
commit without hardlinks, runs Git integrity checks, requires no ambient
database, rebuilds SQLite/FTS with that source revision, compares a canonical
body hash, and answers a known query. It contacts no adapter or output. This
proves compatibility between that data snapshot and program revision on the
same Mac, not a self-contained snapshot, off-machine durability, or
replacement-Mac provisioning.

Daily resurfacing chooses up to three highlights older than 30 days with two manual-origin slots for each AI-origin slot. Never-shown and least-recently-shown passages come first; a passage automatically leaves the pool after five successful sends. A successful live send appends `shown` events to `logs/resurfacing.jsonl`; dry-run previews do not. A channel reply containing `skip` or `stop` plus the displayed `hl_…` id is passed through the installed, explicitly rooted command in `docs/operations.md`, which appends a `retired` event. The existing iMessage agent/channel owns that narrow handoff; Wordhold deliberately does not scrape the user's private Messages database.

## External boundaries

- `papertrail.config.json` and `.env` are local secrets/configuration and ignored.
- Wordhold-created private directories/files use `0700`/`0600` on creation, and installed LaunchAgents set umask `077`. Existing operator-created paths are audited and corrected only deliberately. Git tracks content, not restrictive read modes, so canonical Markdown/history rely on the repository/enclosing-directory boundary after checkout or restore.
- Runtime queues, intents, databases, malformed-input evidence, quarantine/oversize/seen files, and ordinary logs are ignored. The resurfacing and new-tag journals are deliberately tracked. `.gitignore` prevents ordinary staging, not a deliberate force-add.
- Worker secrets, D1, R2, Cloudflare routes, iOS Shortcuts, Full Disk Access, Messages automation, and launchd are deployment/device state. Tests use faithful local boundaries; they do not claim those external systems are configured.
- No component uses a standalone AI API key or paid extraction service.

## Change discipline

Make one coherent vertical slice at a time: behavior test, smallest implementation, green suite, refactor while green, then update this document or the relevant operations guide. Keep daemon and enrichment runtime commits separately inspectable. Do not use broad `git add -A` in runtime code.

Documentation has explicit ownership to keep it useful without drifting copies: `README.md` is the product entry point; this file owns invariants; `setup.md` owns fresh and optional setup; `operations.md` owns lifecycle/recovery; `integrations.md` owns agent behavior and disclosure; `release-verification.md` owns generic synthetic evidence; and private operator evidence owns live account/device facts. Update the closest non-obvious code comment when its safety or lifecycle contract changes.
