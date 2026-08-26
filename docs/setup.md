# Setup

This guide starts with a healthy local-only installation. Optional cloud, device, model, and messaging capabilities come later and remain disabled until their explicit flag and required configuration are both present.

## 1. Acquire, verify, and install local Wordhold

Prerequisites are an Apple-Silicon Mac running macOS 13 or newer and Git. Bun is
needed to run, develop, or build from source, not to install or run the compiled
archive. The binaries declare macOS 13 as their deployment floor, while the
automated packaged gate runs on Apple-Silicon macOS 14; macOS 13 itself is not
yet a tested compatibility claim. Never use another person's private corpus
repository, clone, bundle, or history as program source.

Setup and update also require the macOS validators `/usr/bin/sw_vers`,
`/usr/bin/otool`, and `/usr/bin/lipo`. The current artifact declares those
exact lifecycle commands in its manifest, and the launcher fails before
mutation if they are unavailable or if their results disagree with the
artifact's claimed host compatibility.

Open the canonical public
[GitHub release](https://github.com/adhd/wordhold/releases/tag/v0.5.0-rc.3),
expand **Assets**, and download exactly:

- `Wordhold-0.5.0-rc.3-darwin-arm64.tar.gz`
- `Wordhold-0.5.0-rc.3-darwin-arm64.receipt.json`

Do not choose GitHub's automatically generated **Source code (zip)** or
**Source code (tar.gz)**. They are unqualified source snapshots, not the
compiled release, and cannot run the compiled setup path. The JSON receipt
binds the candidate, source revision, internal release id, Apple-Silicon target,
macOS deployment floor, exact Bun compiler identity, archive name, size, and
digest for audit. Because it comes from the same release page as the archive,
the digest detects mismatched or corrupt release bytes but does not independently
authenticate the publisher.

Safari may automatically expand a `.tar.gz` download. If the named `.tar.gz`
asset is no longer present in Downloads, do not rename the resulting `.tar` or
use the auto-extracted directory. In Safari Settings → General, turn off **Open
“safe” files after downloading**, move that `.tar` and extracted directory to
the Trash, and download the exact `.tar.gz` release asset again. The checksum
below is for the original compressed asset.

Run this block from Terminal after both assets finish downloading:

```sh
RC="0.5.0-rc.3"
ARCHIVE="$HOME/Downloads/Wordhold-$RC-darwin-arm64.tar.gz"
RECEIPT="$HOME/Downloads/Wordhold-$RC-darwin-arm64.receipt.json"
UNPACK="$HOME/Downloads/Wordhold-$RC-unpacked"
RELEASE="$UNPACK/Wordhold-$RC-darwin-arm64"

(
  set -eu
  test ! -e "$UNPACK"
  ls -l "$ARCHIVE" "$RECEIPT"
  test "$(plutil -extract candidate raw "$RECEIPT")" = "v$RC"
  test "$(plutil -extract archive.name raw "$RECEIPT")" = "$(basename "$ARCHIVE")"
  EXPECTED_SHA256="$(plutil -extract archive.sha256 raw "$RECEIPT")"
  printf '%s  %s\n' "$EXPECTED_SHA256" "$ARCHIVE" | shasum -a 256 -c -
  mkdir -m 700 "$UNPACK"
  tar -C "$UNPACK" -xzf "$ARCHIVE"
  codesign --verify --strict "$RELEASE/wordhold"
  if xattr -p com.apple.quarantine "$RELEASE/wordhold" >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$RELEASE"
  fi
  printf 'Verified release: %s\n' "$RELEASE"
)
```

The block stops at its first failed trust check and never executes Wordhold.
Continue only if its final line says `Verified release:`. Use a new `UNPACK`
name if that path already exists; do not merge an extraction with old files.
The receipt and SHA check bind the two files obtained from the canonical GitHub
release; they are an integrity check within that channel, not independent
publisher authentication. The installation command then verifies the complete
internal manifest, hashes, executable inventory, thin `arm64` Mach-O target,
and macOS deployment floor before mutation.

The executables are locally ad-hoc signed, not Developer ID signed or notarized.
An intact ad-hoc signature detects malformed signed bytes but does not identify
a publisher. A browser download may attach `com.apple.quarantine`, and
Gatekeeper may block this experimental public RC because it is not notarized.
The conditional `xattr` command above is an explicit trust decision and clears
quarantine only from the release whose receipt and archive matched; it does not
disable Gatekeeper globally. Review and build the public source instead if that
boundary is unacceptable; use the pinned [source-build
path](../README.md#run-or-develop-from-source). This candidate requires Apple Silicon and macOS 13
or newer; automated qualification currently runs on macOS 14. One observed
machine does not establish broad macOS compatibility.

Defaults:

- program releases: `~/Library/Application Support/Papertrail/app/releases/`
- active program pointer: `…/Papertrail/app/current`
- command wrappers: `…/Papertrail/app/bin/`
- private data/Git authority: `…/Papertrail/data`

The directory names are retained compatibility identifiers from Wordhold's
pre-0.5 name. Fresh and upgraded installations intentionally use the same
namespace so setup cannot create a second archive beside an existing one.

Run exactly one of these adjacent branches from the verified release.

For a Mac with no Papertrail or Wordhold installation:

```sh
cd "$RELEASE"
./wordhold setup
```

For an existing Papertrail or Wordhold installation:

```sh
cd "$RELEASE"
./wordhold update
```

If the existing installation used a custom program root, pass the exact same
root: `./wordhold update --install-root /absolute/custom/program/root`.

On a fresh setup, use `--install-root` and `--data-root` on that same command to
choose other absolute roots. Program, data, and downloaded-artifact roots must
be separate.
Setup validates the exact artifact inventory and Git before mutation. It creates
owner-only paths, an ignored safe config with every optional capability
disabled, an independent private Git repository, canonical journals/tag
vocabulary, and a rebuildable empty index. It performs no Worker request, model
call, message, cloud mutation, or device access.

Verify the local path. If you selected a custom program root, put that exact
root in `INSTALL_ROOT` instead of the default below:

```sh
INSTALL_ROOT="$HOME/Library/Application Support/Papertrail/app"
WORDHOLD="$INSTALL_ROOT/bin/wordhold"

"$WORDHOLD" capture 'https://www.iana.org/help/example-domains'
"$WORDHOLD" drain
printf '{}\n' | "$WORDHOLD" recent --json
"$WORDHOLD" show ITEM_ID_FROM_RECENT
"$WORDHOLD" health
```

`capture` should return a `queued` receipt. The drain should create one
`daemon:` commit. Structured `recent` should show the same canonical URL, item
id, and whether a body is available; replace `ITEM_ID_FROM_RECENT` with that id
to inspect the canonical Markdown. A body may honestly be unavailable when the
site cannot be fetched. A local-only config is healthy after the daemon records
its core source/job run; disabled
optional capabilities are not failures. Deleting `papertrail.db*`, running
`"$WORDHOLD" rebuild`, and repeating `recent` should preserve the same item id.

This completes the local core. Sections 2–4 are optional integrations, not
prerequisites or additional acceptance steps.

The retained Papertrail paths and identifiers are intentional compatibility
contracts. Do not rename the Application Support directory,
`papertrail.config.json`, `papertrail.db*`, `PAPERTRAIL_*` variables,
`app.papertrail.*` jobs, `papertrail` MCP registration, or Keychain/Worker/
Shortcut state. Update adds the preferred `wordhold` command without creating a
second corpus or parallel machine state.

## 2. Codex and Hermes integration (optional)

Use the installed guided command. Connect each client independently:

```sh
"$WORDHOLD" connect codex
# Or:
"$WORDHOLD" connect hermes
```

This adds a local stdio `papertrail` MCP server to the selected real client,
installs generic Hermes guidance when appropriate, and probes the six tools
before reporting success. A missing client is an actionable skipped state. It
sends no corpus content during installation and stores no Wordhold credential.
Follow [integrations.md](integrations.md) for use and selective removal.

Codex or Hermes may send a question and the specific bounded evidence returned by an invoked tool to its configured model provider. Do not enable the integration if that disclosure is unacceptable.

## 3. Scheduled local daemon (optional)

Opt into scheduling explicitly. Configure enrichment, digest, and resurfacing
before this command if you want their jobs installed:

```sh
"$WORDHOLD" schedule
```

This copies the stable daemon and installs `app.papertrail.*` user jobs. Only the
core daemon and explicitly enabled/configured optional jobs are rendered;
reinstalling removes an exact previously managed optional job when its
capability is disabled. Every job uses umask `077`. Launchd is a separate device
integration, not part of default setup. Its owner-only receipt hashes the
installed definitions. A verified update refreshes owned scheduled binaries and
definitions.

If you enable, disable, or finish configuring any of those capabilities later,
rerun `"$WORDHOLD" schedule` to reconcile the owned jobs.

To remove only scheduling:

```sh
"$WORDHOLD" unschedule
```

Program uninstall removes verified scheduled jobs first. It refuses before
program mutation if a plist is changed, unrecognized, unreceipted, or cannot be
booted out safely.
It preserves remote Worker rows and legacy iCloud evidence and cannot edit the
phone Shortcut. Remove the Shortcut and revoke its capture credential separately
if new online captures should stop after uninstall.

If migrating from a pre-distribution installation with another launch-label prefix, remove or boot out those old user jobs before loading `app.papertrail.*`; never leave both schedules active. Full Disk Access is needed only when Reading List is enabled. Grant it to the exact compiled daemon path printed by the installer. Scheduling leaves the stable executable untouched when an update ships byte-identical daemon code, avoiding unnecessary authorization churn. Always recheck health after an update; if daemon bytes changed or Reading List reports `EPERM`/`EACCES`, re-grant FDA.

## 4. Configure optional capabilities

Edit the ignored private `papertrail.config.json`. A capability has three setup states:

- flag `false`: disabled; placeholders are inert;
- flag `true` but a required value absent: unconfigured and non-healthy, with no adapter/job started;
- flag `true` with required values: enabled; runtime health then reports never-run/healthy/stale/failed.

### Enrichment

Requires a locally authenticated Codex CLI. Run `codex login status`; Wordhold deliberately removes `OPENAI_API_KEY` from the child environment. Set `capabilities.enrichment=true` only after accepting that a selected full item body is sent to the configured OpenAI service. Enrichment remains bounded, schema-constrained, and separately committed.

### Digest and resurfacing

Set a private Messages recipient, keep `imessage.dryRun=true`, and enable only the desired job flag. Dry-run writes a private local outbox. A live send requires changing dry-run deliberately and granting macOS Automation to the invoking executable. Full Disk Access and Messages Automation are unrelated permissions.

### Safari Reading List

In the private `papertrail.config.json`, set
`capabilities.readingList` to `true` and `readingListPlist` to
`~/Library/Safari/Bookmarks.plist`. Then schedule Wordhold or run it manually.
Reading List needs Full Disk Access for the stable compiled daemon at
`$DATA/dist/papertrail-daemon` (the installer prints the resolved absolute
path); `EPERM`/`EACCES` is a visible setup failure, never an empty source.
Reading List permission is unrelated to iPhone Shortcut capture; the latter
does not need Full Disk Access.

For Reading List captures from iPhone, sign the iPhone and Mac into the same
Apple Account and enable Safari under iCloud on both devices. Use Safari's
native **Add to Reading List** action; it is independent of the optional online
Wordhold Shortcut. The Mac can be off at capture time, but you must later wake
it and log in so it can receive Safari's iCloud sync before the daemon archives
the page.

### iPhone capture (optional)

Wordhold's currently qualified online Shortcut retains the pre-0.5 name
**Save to Papertrail — Online**. Its signed bytes, digest, and bounded device
qualification are an exact release contract; it saves into the same Wordhold
archive and remains supported. That evidence does not prove a new operator's
phone or Worker. A separately qualified Wordhold-named Shortcut may replace it
later, but documentation and code must not relabel the old file.

Use Safari **Add to Reading List** as the zero-Cloudflare path for a new or
local-only installation. After installing the bundled 0.4.0 **Save to
Papertrail — Online** action and observing one valid `Accepted by Papertrail:
in_…` response from that installed Shortcut, prefer it for ordinary one-page
Safari saves. The receipt means the URL is durably queued; do not also add it to
Reading List. Use Reading List as the fallback when the phone is offline or the
online path cannot return that receipt. The Shortcut's generic graph accepts
Text, URL, and Safari Web Page input classes, but only the Safari gesture has
passed a live device gate; other Share Sheet providers are not live-qualified.
It needs phone internet plus Wordhold's optional Cloudflare Worker. That
receipt does not mean the Mac has archived the item yet.

The Mac may be off during the share. The Worker retains the row until a later
daemon pass commits and acknowledges it. Wordhold, Terminal, and Codex do not
need to be open at capture time. Automatic later processing requires the Worker
inbox and Wordhold scheduling to be enabled; without scheduling, run
`"$WORDHOLD" drain` manually. This Shortcut has no offline fallback. Text and
Safari inputs are used only to extract one URL: it does not preserve notes,
highlights, selected text, or PDF contents, and it refuses zero or multiple
URLs.

First deploy the optional Worker and create distinct admin and capture-only
credentials as described below. Store the capture-only value in macOS Keychain
under an installation-specific account and service
`papertrail-capture-secret`; never put the admin credential on the phone. Then
follow **Install the online iPhone client** below.

The failed local-file 0.3.5, 0.3.6, and 0.3.7 workflows were not imported into
this public history. They are not bundled alternatives and must not be
imported. Existing legacy queue evidence remains readable for recovery; it is
not an active setup path.

### Cloudflare Worker, D1, and R2

Cloudflare is optional and separately deployed. The source checkout contains
`worker/wrangler.distribution.toml`; a built artifact materializes that template
as `worker/wrangler.toml`. Do not edit the copy inside an immutable installed
release. Copy the complete unpacked artifact into a separate mutable private
deployment workspace, run `bun install` at its root, and populate
`worker/wrangler.toml` there. Keep that config and provider state out of every
distributable product tree, create the referenced D1/R2 resources once, apply
migrations, and upload distinct admin and capture-only secrets. Never leave
`REPLACE_WITH_…` values in an enabled deployment.

For a fresh deployment, use one private workspace and this bounded sequence:

```sh
cd /absolute/path/to/private-wordhold-worker
bun install --frozen-lockfile --ignore-scripts
bunx wrangler login
bunx wrangler d1 create YOUR_D1_DATABASE
bunx wrangler r2 bucket create YOUR_R2_BUCKET
```

Copy the returned D1 name/id and the R2 bucket name into
`worker/wrangler.toml`, replacing every `REPLACE_WITH_…` value. Then apply the
schema, store two different values at Cloudflare's secret prompts, and deploy:

```sh
bunx wrangler d1 migrations apply YOUR_D1_DATABASE --remote \
  --config worker/wrangler.toml
bunx wrangler secret put SECRET --config worker/wrangler.toml
bunx wrangler secret put CAPTURE_SECRET --config worker/wrangler.toml
bunx wrangler deploy --config worker/wrangler.toml
```

Keep the admin value named `SECRET` on the Mac only. In the private data root's
`papertrail.config.json`, set `capabilities.workerInbox` to `true`, set
`worker.baseUrl` to the deployed HTTPS origin, and set `worker.secret` to
`env:PAPERTRAIL_SECRET`. Create or edit `$DATA/.env` with mode `0600`, define
the variable named `PAPERTRAIL_SECRET` there with the same admin value, and do
not place `CAPTURE_SECRET` in that file. Run `"$WORDHOLD" drain` and
`"$WORDHOLD" health` before configuring the phone. The capture-only credential
is stored separately in Keychain during the iPhone flow below.

An existing Papertrail deployment keeps its current Worker name, URL, D1/R2
bindings, and secrets; do not create parallel Wordhold resources during the
rename. For a genuinely fresh deployment, `wordhold-worker` is only the generic
template name and may be replaced before the first deploy.

The phone token may call only capture; it must receive 403 from drain/body/ack/allow/admin routes. The Mac admin secret stays off the phone. Enable `workerInbox` only after its base URL and admin secret are populated and least privilege is verified. That Mac-side capability is what later drains accepted phone rows; `iphone setup` does not enable it. Enable Wordhold scheduling as well if the drain should happen automatically. Cloudflare Email Routing additionally requires a domain managed in that account; it is unrelated to URL capture and is not needed for this setup.

### Install the online iPhone client

Worker deployment and capture-token creation remain private installation-owner
work; the packaged command does not mutate Cloudflare. In Keychain Access, create a
password item whose name/service is `papertrail-capture-secret`, whose account
is unique to this installation, and whose password is the deployed
capture-only token. `--base-url` must be the Worker HTTPS origin only: no route
path, query, fragment, or embedded credential. Then run from the installed
release:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" iphone setup \
  --base-url https://YOUR_WORKER_ORIGIN \
  --keychain-account YOUR_INSTALLATION_ACCOUNT
```

Setup first resolves the Mac's matching Worker inbox configuration and sends one
admin-authenticated `GET /v1/drain?limit=1&cursor=~` probe. The nonempty high
cursor bypasses first-page recovery and sorts after Wordhold inbox ids, so the
probe validates the drain contract without reading or acknowledging a queued
row. Setup refuses an unresolved, mismatched, or unauthorized Mac drain. It
then sends empty invalid-capture probes and forbidden-route probes with the
capture-only credential. The capture routes must reach their exact validation
errors; drain, body, acknowledgement, and sender administration must deny that
credential. No credential value is printed. The ignored config stores only the
verified HTTPS origin and Keychain reference, never the token.

The command prints the exact qualified compatibility `Save to Papertrail —
Online.shortcut` path and SHA-256 plus the first import answer, which ends in
`/v1/save`. Transfer that exact `.shortcut` file to the iPhone and choose **Add
Shortcut**. The shared bytes contain two empty Text actions and no endpoint or
credential. Import personalizes the installed copy. For the second import
question, run:

```sh
"$WORDHOLD" iphone shortcut copy-token
```

The command reads the configured Keychain item and places its secret value on
the Mac clipboard. Paste it through Universal Clipboard, finish the import,
then run:

```sh
"$WORDHOLD" iphone shortcut clear-token
```

It clears only when the clipboard still exactly matches the current Keychain
token, so it cannot erase newer clipboard contents. Treat the personalized
installed Shortcut and any synced copy as credential-bearing device state.
Record that the exact offered artifact was accepted without claiming a live
phone run:

```sh
"$WORDHOLD" iphone shortcut approve
"$WORDHOLD" iphone status
```

On the iPhone in Safari, share one page and choose **Save to Papertrail —
Online**. Zero or multiple extracted URLs are refused before networking. A network,
authentication, validation, server, or malformed-receipt failure cannot show
success. Only `Accepted by Papertrail: in_…` is a Worker queue receipt; use
`wordhold recent` or structured retrieval after the daemon runs to prove archival.
`iphone status` continues to report `liveDevice: unknown`: it can inspect local
configuration and offered/approved digests, not the phone.

To rotate the phone credential, upload a new `CAPTURE_SECRET`, replace the same
Keychain item's password, and rerun `iphone setup`. Keychain is only the Mac's
source for verification and clipboard copy; rotation does not propagate to the
phone. Setup deliberately returns status to `approval_required`, even when the
reference names and generic artifact are unchanged. Copy the new token and
replace the personalized token Text value without changing the graph, or
re-import the exact offered artifact and answer both questions again; then run
`iphone shortcut clear-token` and `iphone shortcut approve`. Never put the
admin `SECRET` there. To remove this client,
delete the Shortcut from the iPhone, revoke or rotate `CAPTURE_SECRET` if it
should no longer authorize any capture client, remove the Keychain item if no
longer needed, and run:

```sh
"$WORDHOLD" iphone disable
```

That command removes only Wordhold's local online-client reference. It does
not pretend to edit the phone, revoke a remote token, delete Worker rows, touch
the corpus, or remove preserved legacy iCloud evidence.

## 5. Verification boundaries

Local tests and fake external seams prove product behavior, not live account/device state. Record generic synthetic release proof in `release-verification.md`; keep installation-specific endpoints, recipients, resource identifiers, permissions, and observed device results in private operator evidence outside a distributed artifact.
