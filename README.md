# Wordhold

Wordhold is a public-source, local-first reading archive for one macOS user. It
queues links and notes, commits canonical Markdown to a private data Git
repository, maintains a rebuildable SQLite/FTS index, and gives local agents a
bounded evidence interface. There is no reader UI or hosted account.

The default installation is local-only. Cloudflare, iCloud, Safari Reading
List, models, Messages, digest, and resurfacing are all optional and remain
disabled until explicitly configured.

## Start here

- **Understand the product:** [how Wordhold works day to day](docs/how-it-works.md)
- **Install or update:** [setup](docs/setup.md)
- **Operate, troubleshoot, back up, recover, or remove:** [operations and recovery](docs/operations.md)
- **Add optional integrations:** [setup](docs/setup.md#2-codex-and-hermes-integration-optional), [agent integrations](docs/integrations.md), and the [iPhone Shortcut contract](integrations/shortcuts/Papertrail.md)
- **Contribute or integrate an agent:** [run from source](#run-or-develop-from-source), [architecture](docs/architecture.md), and [agent integrations](docs/integrations.md)
- **Build a release:** [release verification](docs/release-verification.md) and [source provenance](docs/source-provenance.md)

## Install the public release candidate

Wordhold 0.5 is self-hosted software for technical users with an Apple-Silicon
Mac running macOS 13 or newer. Git is required because each installation keeps
its private archive under Git authority. Bun and a source checkout are not
required to install or run the compiled release candidate. The executables
declare macOS 13 as their deployment floor; automated packaged qualification
runs on an Apple-Silicon macOS 14 host, so macOS 13 itself is not yet a tested
compatibility claim.

From the canonical [GitHub Releases](https://github.com/adhd/wordhold/releases)
page for `v0.5.0-rc.3`, download exactly:

- `Wordhold-0.5.0-rc.3-darwin-arm64.tar.gz`
- `Wordhold-0.5.0-rc.3-darwin-arm64.receipt.json`

Do **not** download GitHub's automatically generated **Source code (zip)** or
**Source code (tar.gz)**. They do not contain the qualified compiled launcher.
The receipt and archive digest detect mismatched or corrupt bytes from the
GitHub release channel, but they are not independent publisher authentication.

The release is ad-hoc signed rather than Developer ID signed or notarized. Its
manifest identifies the Wordhold version, source revision, exact Bun compiler
version/revision/digest, macOS deployment floor, target architecture,
executable inventory, and every file hash. Verification inspects the thin
`arm64` Mach-O architecture and deployment target of every executable and
records that runtime `.env` and `bunfig.toml` autoload were disabled during
compilation. Installation rejects an incompatible, incomplete, modified, or
extra-file artifact. Review and build the public source if this trust boundary
is not acceptable.

Follow [Setup](docs/setup.md) for the single acquisition, checksum, extraction,
and quarantine flow, then choose its adjacent fresh-setup or existing-update
branch. The launcher exists only in the unpacked release artifact. Fresh setup
creates separate owner-only program and data roots with every optional
integration disabled; setup is safe to run twice.

The complete local core loop is:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" capture 'A note for Wordhold'
"$WORDHOLD" drain
"$WORDHOLD" recent
"$WORDHOLD" health
```

`capture` returns `queued`. Only `drain` and its scoped Git commit make the note
part of the archive. No optional integration is needed to verify this loop.

### Update an existing installation

Acquire and verify the new public release exactly as for setup, then run its
launcher from that newly unpacked release:

```sh
./wordhold update
```

Update preserves the corpus and Git history, data root, item ids, config,
scheduled-job namespace, MCP key, Keychain reference, Worker deployment, and
signed phone Shortcut. Cloning or editing this source repository does not
update an installed copy. See [operations](docs/operations.md) for update and
rollback behavior.

### Compatibility names

Wordhold was called Papertrail through version 0.4. The Application Support
directory, `papertrail.config.json`, `papertrail.db*`, `PAPERTRAIL_*`
environment variables, `app.papertrail.*` LaunchAgents, `papertrail` MCP key,
and `papertrail` / `pt` aliases remain compatibility identifiers. Do not rename
them: doing so can create a second corpus or detach existing device and
credential state.

## How storage and capture work

```text
explicit capture -> private raw spool -> canonical Markdown -> derived SQLite
                                      -> scoped Git commit -> acknowledgement

agent question -> local stdio MCP -> bounded search/get/health/doctor results
```

- `items/YYYY/MM/*.md`, `agent/tags.md`, and tracked journals are canonical
  authority in the installation's private data Git repository.
- `papertrail.db*` is disposable derived state; `wordhold rebuild` recreates it.
- A non-empty extracted body, manual highlight, captured context, provenance,
  and stable id are not silently rewritten.
- Upstream input is acknowledged only after its required canonical commit.
  Replay is at-least-once and idempotent.
- A saved item with no usable body is not represented as supporting evidence.

The product source repository contains no corpus or operator state. Every
installation creates a separate private data repository that must never be
published. See [how Wordhold works](docs/how-it-works.md) for the human model and
[architecture](docs/architecture.md) for authority and failure invariants.

## Optional integrations

All optional capabilities require explicit configuration and their own live
verification. Example placeholders never activate them.

- **Scheduled local processing:** macOS LaunchAgents can drain at login and on a
  schedule; without scheduling, run `wordhold drain` manually.
- **iPhone without Cloudflare:** Safari **Add to Reading List** syncs through
  iCloud to the Mac. It requires Reading List configuration and Full Disk
  Access for the daemon.
- **Receipt-bearing iPhone capture:** the optional **Save to Papertrail —
  Online** Shortcut sends one Safari URL to a configured Cloudflare Worker. Its
  `Accepted by Papertrail: in_…` message means remotely queued, not archived.
  It has no offline queue and does not preserve notes, highlights, selected
  text, or PDF contents. Use Reading List when it cannot return a valid receipt.
- **Agents and enrichment:** Codex or Hermes can use bounded local MCP tools;
  enrichment can send one selected full article body to the locally
  authenticated Codex CLI.
- **Messages:** digest and resurfacing can send derived text through Messages.

The Mac and Codex may be off when an iPhone capture is made. Archival happens
only after the Mac wakes, receives any required sync, and the daemon commits the
item. See [day-to-day behavior](docs/how-it-works.md), [optional setup](docs/setup.md#4-configure-optional-capabilities), and the [Shortcut contract](integrations/shortcuts/Papertrail.md).

## Agent use and privacy

The local stdio MCP server exposes six tools: bounded `search_items`,
`get_item`, and `recent_items`; redacted `health`; metadata-only `doctor`; and
the explicit side-effecting `queue_capture`. It exposes no shell, arbitrary file
read, secret, migration, acknowledgement, admin, or remote corpus tool. Corpus
text is untrusted data, never instructions. `queued` never means archived.

Connect only the client wanted:

For Codex:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" connect codex
```

For Hermes:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" connect hermes
```

The guided command starts the registered server, checks that it advertises the
exact six tool names, and stores no Wordhold credential. It does not invoke the
tools or read corpus content during connection. See [agent
integrations](docs/integrations.md) for supported queries, selective removal,
and exact disclosure behavior.

Canonical authority stays local, but enabled actions may disclose data:

- saving or extracting a URL contacts its public publisher;
- Codex or Hermes may send the question and selected bounded evidence to their
  configured model provider;
- enrichment sends one selected full article body to the configured OpenAI
  service through the locally authenticated Codex CLI;
- optional Worker/iCloud capture sends capture payloads to those services;
- optional digest/resurfacing sends derived text through Messages.

Wordhold has no automatic or single bulk-corpus upload. A connected client can
still enumerate and retrieve many items through repeated bounded calls and may
send returned evidence to its model provider. Provider retention, training,
residency, and deletion behavior remain provider responsibilities.

## Core archive commands

This is the compact archive interface, not an exhaustive lifecycle or
integration command list. Setup and Operations own installation, update,
scheduling, connection, and removal commands.

```text
wordhold capture <URL-or-text>
wordhold capture --json             # one JSON request on stdin
wordhold drain
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

Human commands retain compact output. Structured requests are versioned JSON.
Read operations do not modify canonical state or Git; `doctor` also opens the
existing index read-only. For scheduling, logs, updates, troubleshooting,
backup, recovery, and removal, use [operations](docs/operations.md).

## Run or develop from source

This Bun-dependent route is for contributors and operators who prefer to run
reviewed public source. The compiled release above is the simpler install path.
Install Bun 1.3.11 using the official guide's [older-version
procedure](https://bun.sh/docs/installation#installing-older-versions) and the
tag `bun-v1.3.11`; the guide's default command installs the current release,
which is not a substitute for the pinned compiler checked below.

Pin the checkout and toolchain before using source as program authority:

```sh
(
set -eu
git clone https://github.com/adhd/wordhold.git
cd wordhold
git checkout v0.5.0-rc.3
BUN_EXECUTABLE="$(command -v bun)"
test "$(shasum -a 256 "$BUN_EXECUTABLE" | awk '{print $1}')" = \
  "1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6"
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
)
```

To install a compiled artifact built from that checkout, use explicit paths:

```sh
(
set -eu
cd /absolute/path/to/wordhold
bun run build:distribution -- --output /absolute/new/output
cd /absolute/new/output
./wordhold setup
)
```

This development build has an internally verified manifest but no
public-release receipt; only the release assets above have passed remote RC
qualification.

Contributors should start with [architecture](docs/architecture.md). Release
maintainers must use the fail-closed process in [release verification](docs/release-verification.md) to bind a clean tagged revision to the compiled archive and receipt; ordinary installations do not run that process. [Source provenance](docs/source-provenance.md) explains the history-free public snapshot.

## Repository and documentation map

- `core/`: authority, structured query, diagnosis, configuration, Git, and installation contracts
- `daemon/`: local transaction, source adapters, extraction, digest, and resurfacing
- `mcp/`: thin local stdio adapter
- `agent/`: bounded enrichment code and product-owned prompt/schema
- `worker/`: optional Cloudflare ingress
- `integrations/`: generic Hermes and iPhone guidance
- `scripts/`: initialization, packaging, lifecycle, integrations, and operations
- [How it works](docs/how-it-works.md): daily use and asynchronous behavior
- [Setup](docs/setup.md): verified install, update, and optional integrations
- [Operations](docs/operations.md): health, update, troubleshooting, backup, recovery, and removal
- [Agent integrations](docs/integrations.md): client behavior, supported queries, and privacy
- [Architecture](docs/architecture.md): authority, trust boundaries, data flow, and failures
- [Release verification](docs/release-verification.md): synthetic release evidence and proof limits
- [Source provenance](docs/source-provenance.md): public snapshot origin
- [Security](SECURITY.md): private vulnerability reporting and redaction
- [Decision 0001](docs/decisions/0001-self-hosted-single-owner.md): the single-owner boundary
- `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`: licensing

Installation-specific endpoints, recipients, resource identifiers,
permissions, and device evidence belong in private operator records, not this
public repository.

## Supported boundary

Wordhold 0.5 is public, local-first, single-owner macOS software. The compiled
release candidate requires Apple Silicon and macOS 13 or newer, is automatically
qualified on Apple-Silicon macOS 14, and is ad-hoc signed rather than Developer
ID signed or notarized. macOS 13 remains an untested deployment-floor claim.

Linux, Windows, Intel Macs, hosted or multi-tenant operation, a public HTTP MCP
endpoint, reader UI, collaboration, billing, semantic/vector search, PDF/OCR
extraction, X scraping, paywall bypass, and automatic repair are unsupported.
Issues and pull requests are handled on a best-effort basis. Wordhold is
licensed under Apache-2.0 with no warranty; use GitHub private vulnerability
reporting for security reports. Read [the decision record](docs/decisions/0001-self-hosted-single-owner.md) before widening this boundary.
