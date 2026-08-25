# Wordhold

Wordhold is a public-source, local-first reading archive for one macOS user. It
queues links and notes, commits canonical Markdown to a private data Git
repository, maintains a rebuildable SQLite/FTS index, and gives local agents a
bounded evidence interface. There is no reader UI or hosted account.

The default installation is local-only: no Cloudflare, iCloud, Safari Reading List, model, Messages, digest, or resurfacing capability is enabled. Optional integrations are configured separately and never become active from example placeholders.

## Install the public release candidate

Wordhold 0.5 is public, self-hosted software for technical users with an
Apple-Silicon Mac running macOS 13 or newer. Git is required because each
installation keeps its private archive under Git authority. Bun and a source
checkout are not required to install or run the compiled release candidate.
The executables declare macOS 13 as their deployment floor; automated packaged
qualification runs on an Apple-Silicon macOS 14 host, so macOS 13 itself is not
yet a tested compatibility claim.

From the canonical [GitHub Releases](https://github.com/adhd/wordhold/releases)
page for `v0.5.0-rc.2`, download exactly these two assets:

- `Wordhold-0.5.0-rc.2-darwin-arm64.tar.gz`
- `Wordhold-0.5.0-rc.2-darwin-arm64.receipt.json`

Do **not** download GitHub's automatically generated **Source code (zip)** or
**Source code (tar.gz)**. Those are source snapshots, not the qualified
compiled Wordhold release, and they do not contain the compiled launcher. The
receipt records candidate identity and the archive digest. Because both assets
arrive through the same GitHub channel, that digest detects mismatched or
corrupt bytes but is not independent publisher authentication.

Follow the single acquisition, checksum, extraction, and quarantine flow in
[Setup](docs/setup.md), then choose its adjacent fresh-setup or existing-update
branch. The compiled launcher checks the artifact manifest and Git before
creating or updating anything. The launcher exists only in
the unpacked release artifact; it is not checked into this source repository as
a compiled binary.

Fresh setup creates separate owner-only program and data roots and leaves every
optional integration disabled. The complete local core loop is:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" capture 'A note for Wordhold'
"$WORDHOLD" drain
"$WORDHOLD" recent
"$WORDHOLD" health
```

`capture` returns `queued`; only `drain` and its scoped Git commit make the note
part of the archive. Running setup twice is safe. Cloudflare, iPhone capture,
Safari Reading List, scheduling, Codex, Hermes, enrichment, Messages, digest,
and resurfacing are optional follow-on integrations; none is needed to install
or verify the local archive.

### Compatibility names

Wordhold was called Papertrail through version 0.4. The first Wordhold release
deliberately retains the established machine-facing namespace: the Application
Support directory, `papertrail.config.json`, `papertrail.db*`, `PAPERTRAIL_*`
environment variables, `app.papertrail.*` LaunchAgents, the `papertrail` MCP
registration, and the existing `papertrail` / `pt` command aliases. Keeping
those identifiers prevents an upgrade from creating a second corpus, losing a
Keychain reference, duplicating scheduled jobs, or invalidating Full Disk
Access. They are compatibility identifiers, not a second product. Do not rename
them manually.

### Existing Papertrail installation

Use the same public-release acquisition and verification flow above, then run
the Wordhold RC launcher from that exact unpacked release with `update` instead
of `setup`:

```sh
./wordhold update
```

This adds the preferred `wordhold` command and updates the program in place. It
preserves the existing corpus and Git history, data root, item ids, config,
scheduled-job namespace, MCP key, Keychain reference, Worker deployment, and
signed phone Shortcut. Merely cloning or editing this source repository does
not update an installed copy.

## iPhone capture (optional)

Safari **Add to Reading List** is the zero-Cloudflare iPhone path for a new or
local-only installation. The currently qualified online client retains its
pre-rename title. After the optional Worker is configured and **Save to
Papertrail — Online** has returned one valid `Accepted by Papertrail: in_…`
receipt from the installed iPhone Shortcut, the online action is the preferred
daily path for directly sharing one Safari page with one detectable public URL.
That receipt means the Worker durably queued the page; do not also add that page
to Reading List. Use Reading List instead when the phone is offline, the Worker
or token is unavailable, or the Shortcut does not return a valid receipt.

The Shortcut's generic graph also accepts Text and URL input classes, but
providers outside Safari have not passed a live device gate. The Mac and Codex
may be off at capture time. Archival happens after the Mac next runs the
daemon—automatically when scheduling and Worker draining are enabled, or
through a manual `wordhold drain`.

From an installed release:

```sh
"$WORDHOLD" iphone setup \
  --base-url https://YOUR_WORKER_ORIGIN \
  --keychain-account YOUR_INSTALLATION_ACCOUNT
"$WORDHOLD" iphone status
```

Setup verifies the saved Keychain credential is capture-only and prints the
exact signed Shortcut, digest, endpoint answer, and token-copy command. The
shared artifact contains no endpoint or token; its installed copy is
personalized during import. Setup does not claim the Shortcut was imported or
run. The online action extracts a URL only: it does not preserve notes,
highlights, PDF contents, or selected text, rejects zero or multiple URLs, and
has no offline queue. See [setup](docs/setup.md#iphone-capture-optional) and the
[Shortcut contract](integrations/shortcuts/Papertrail.md). The failed
local-file 0.3.5, 0.3.6, and 0.3.7 workflows remain withdrawn, were not imported
into this public history, and are not shipped as active choices.

Safari Reading List is a separate optional URL route, not a Shortcut. When it
is enabled and the compiled daemon has Full Disk Access, Safari/iCloud syncs the
list to the Mac and Wordhold imports it asynchronously. The Mac and Codex do
not need to remain running at the moment of the phone gesture; the Mac must
eventually wake and sync before Wordhold can archive the page. See [how
Wordhold works day to day](docs/how-it-works.md).

The artifact manifest identifies its Wordhold version, source revision, exact
Bun compiler version/revision/digest, macOS deployment floor, target
architecture, executable inventory, and every file hash. Verification inspects
the actual thin Mach-O architecture and deployment target of every executable,
and records that runtime `.env` and `bunfig.toml` autoload were disabled during
compilation. Installation rejects an incompatible, incomplete, modified, or
extra-file artifact. The receipt and adjacent hashes bind the files obtained
from the canonical release, but the ad-hoc signatures do not identify a
publisher. Review and build the public source if that trust boundary is not
acceptable.

## Run or develop from source

This Bun-dependent path is for people who prefer to run the public source or
contribute to it. The compiled release above is the simpler installation path.

Pin the checkout and toolchain before using source as program authority:

```sh
git clone https://github.com/adhd/wordhold.git
cd wordhold
git checkout v0.5.0-rc.2
test "$(bun --version)" = "1.3.11"
test "$(bun --revision)" = "1.3.11+af24e281e"
test "$(bun -e 'process.stdout.write(Bun.revision)')" = \
  "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f"
bun install --frozen-lockfile --ignore-scripts
bun run verify:licenses
bun test
bun run typecheck
bun run worker:typecheck
bun run compile
bun run init:local -- --data-root /absolute/path/to/private-data
PAPERTRAIL_ROOT=/absolute/path/to/private-data bun run pt recent
```

To install a compiled artifact built from that reviewed checkout, run
`bun run build:distribution -- --output /absolute/new/output`, then run
`./wordhold setup` inside the new output directory. This development build has
an internally verified manifest but no public-release receipt; only the release
assets above have passed the remote RC qualification.

This source repository contains no corpus or operator state. It is the canonical
product-code authority described in [source provenance](docs/source-provenance.md).
Each installation creates a separate private data Git repository that must never
be published. Release maintainers use the fail-closed producer command in
[release verification](docs/release-verification.md) to bind a clean tagged
revision to the compiled archive and receipt. Ordinary installations do not run
that maintainer-only command.

## Authority and transaction

```text
explicit capture -> private raw spool -> canonical Markdown -> derived SQLite
                                      -> scoped Git commit -> acknowledgement

agent question -> local stdio MCP -> bounded search/get/health/doctor results
```

- `items/YYYY/MM/*.md`, `agent/tags.md`, and the tracked journals are canonical private Git authority.
- `papertrail.db*` is disposable derived state. `wordhold rebuild` recreates it from canonical files.
- A non-empty extracted body, manual highlight, captured context, provenance, and stable id are not silently rewritten.
- Upstream input is acknowledged only after its required canonical commit. Replay is at-least-once and idempotent.
- Source failures are isolated and visible. A saved item with no usable body is not represented as supporting evidence.

## Agent use

The shared application boundary is available through structured CLI JSON and a thin local stdio MCP server. MCP exposes only:

- `search_items`: bounded FTS evidence with explicit dates/source/status/tag filters;
- `get_item`: one stable item with a deliberately bounded body;
- `recent_items`: keyset-paginated citation metadata without bodies, optionally
  bounded by source and a lower capture date;
- `health`: runtime and capability state with redacted errors;
- `doctor`: metadata-only archive coverage and index agreement;
- `queue_capture`: an explicit, side-effecting local queue receipt.

It exposes no shell, arbitrary file read, secret, migration, acknowledgement, admin, or remote corpus tool. Corpus text is untrusted data, never instructions. Search results carry stable item ids, dates, and source URLs; agents should cite these and distinguish no match from a body-unavailable item.

Connect only the real client wanted, using the installed guided command:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" connect codex
# Or, independently:
"$WORDHOLD" connect hermes
```

The command probes the registered six-tool stdio server before reporting
success. It contains no credential. See [agent integrations](docs/integrations.md)
for exact behavior, selective removal, and disclosure boundaries.

## Privacy and what can leave the Mac

Canonical authority stays local, but enabled actions may disclose data:

- saving or extracting a URL contacts its public publisher;
- Codex or Hermes may send the user’s question and selected bounded evidence to their configured model provider;
- enrichment sends one selected full article body to the locally authenticated Codex CLI;
- optional Worker/iCloud capture sends capture payloads to those services;
- optional digest/resurfacing sends derived text through Messages.

None of those optional actions is enabled by local initialization. Wordhold never uploads the corpus wholesale. Provider retention, training, residency, and deletion behavior are provider responsibilities, not inferred here.

## Commands

```sh
wordhold capture <URL-or-text>
wordhold capture --json             # one JSON request on stdin
wordhold recent [limit]
wordhold recent --json              # {"limit":20} on stdin
wordhold search <terms>
wordhold search --json              # structured filters on stdin
wordhold show <item-id>
wordhold show --json                # bounded {"id":...,"maxChars":...}
wordhold health [--json]
wordhold doctor [--json]
wordhold rebuild
```

Human commands retain compact output. Structured requests are versioned JSON. Read operations do not modify canonical state or Git; `doctor` also opens the existing index read-only.

## Capabilities

`papertrail.config.json` is private and ignored. New configs contain explicit flags for Worker inbox, iCloud inbox, Reading List, enrichment, digest, and resurfacing. Health distinguishes `disabled`, `unconfigured`, `never_run`, `healthy`, `stale`, and `failed`. A pre-distribution populated config without flags keeps legacy behavior; new installations never infer enablement from paths or examples.

Optional components include:

- Cloudflare Worker/D1/R2 capture and newsletter buffering;
- Safari Reading List ingestion, which requires Full Disk Access for the compiled daemon;
- bounded Codex enrichment;
- deterministic digest and highlight resurfacing through Messages.

These components are implemented but not part of local-only health. Enabling them requires the relevant setup and a real verification; configuration or tests are not proof that an account/device edge is live.

## Repository map and documentation

- `core/`: authority, structured query, diagnosis, configuration, Git, and installation contracts
- `daemon/`: local transaction, source adapters, extraction, digest, and resurfacing
- `mcp/`: thin local stdio adapter
- `agent/`: bounded enrichment code and product-owned prompt/schema
- `worker/`: optional Cloudflare ingress
- `integrations/`: generic Hermes and iPhone guidance
- `scripts/`: initialization, sanitized packaging, lifecycle, integrations, and optional operations
- `docs/architecture.md`: authority, trust boundaries, data flow, and failures
- `docs/how-it-works.md`: day-to-day flow, asynchronous behavior, and runtime responsibilities
- `docs/setup.md`: clean install and optional integration setup
- `docs/integrations.md`: Codex, Hermes, MCP, privacy, and supported queries
- `docs/operations.md`: health, update, uninstall, troubleshooting, backup, and recovery
- `docs/release-verification.md`: synthetic release evidence and remaining proof limits
- `docs/source-provenance.md`: why this repository has a history-free product snapshot
- `SECURITY.md`: private vulnerability reporting and redaction rules
- `LICENSE`: Apache-2.0 terms for Wordhold source
- `NOTICE`: Wordhold copyright and licensing notice
- `THIRD_PARTY_NOTICES.md`: generated production dependency and embedded-runtime notices
- private operator evidence: installation-specific proof, deliberately not shipped
- `docs/decisions/0001-self-hosted-single-owner.md`: why hosted/multi-user work is deferred

## Supported boundary

Wordhold 0.5 is public, local-first, single-owner macOS software. The compiled
release candidate requires Apple Silicon and macOS 13 or newer, is automatically
qualified on Apple-Silicon macOS 14, and is ad-hoc signed rather than Developer
ID signed or notarized. macOS 13 remains an untested deployment-floor claim.
Linux, Windows, Intel Macs,
hosted/multi-tenant operation, a public HTTP MCP endpoint, reader UI,
collaboration, billing, semantic/vector search, PDF/OCR extraction, X scraping,
paywall bypass, and automatic repair are unsupported. Issues and pull requests
are handled on a best-effort basis. Wordhold is licensed under Apache-2.0 with
no warranty; use GitHub private vulnerability reporting for security reports.
Read [the decision record](docs/decisions/0001-self-hosted-single-owner.md)
before widening this boundary.
