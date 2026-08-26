# Operations and recovery

Wordhold is intended to run without routine human upkeep. Use this guide when checking health, deploying an update, or recovering from a failure.

Wordhold 0.5 retains the Papertrail machine namespace used by earlier releases.
The paths and identifiers below are therefore intentional compatibility
contracts. Update an existing installation in place; do not create parallel
Wordhold-named data, LaunchAgent, MCP, Keychain, Worker, or Shortcut state. A
fresh optional Worker may use the Wordhold template name documented below.

## Source-distribution lifecycle

Install and update only from the canonical GitHub release after its receipt and
complete archive SHA-256 agree. That same-channel check establishes release
integrity, not independent publisher identity. The adjacent manifest then
checks exact inventory, file hashes, executable modes, and host compatibility
during lifecycle operations:

```sh
APP="$HOME/Library/Application Support/Papertrail/app"
DATA="$HOME/Library/Application Support/Papertrail/data"
WORDHOLD="$APP/bin/wordhold"

# First release:
cd /path/to/unpacked-wordhold-artifact
./wordhold setup

# Later, run update from the newly unpacked release:
cd /path/to/unpacked-new-wordhold-artifact
./wordhold update

# If setup used a custom program root, repeat that exact root:
./wordhold update --install-root /absolute/custom/program/root

"$WORDHOLD" uninstall
```

Acquisition checks the launcher's ad-hoc signature. Install/update then stages a
complete version under the program root, validates the manifest, hashes, modes,
actual executable architecture/deployment floor, and target, and only then
atomically replaces `current`. Complete signature verification for all shipped
executables is a release-qualification gate, not a lifecycle claim. The receipt
pins the private data root while the verified symlink is the single
active-release authority. A staging or validation failure leaves the prior
release and corpus usable. Re-running setup is idempotent. Running `update` from
the installed wrapper reports that the current release is already active;
obtain and verify a new archive first. If an owned LaunchAgent reload previously
failed after activation, that same installed `update` command validates and
retries the scheduled-job reconciliation before reporting that no program
update was needed.

Default uninstall removes only exact installer-owned program releases, wrappers,
pointer, receipt, verified LaunchAgents, and unchanged managed client state. Any
extra or changed member makes it refuse before deleting program files. It
reports but does not remove the separate data root, `papertrail.config.json`,
private Git history, queues, credentials, or remote resources. If a recorded
Codex/Hermes CLI was independently removed, reinstall that client and retry;
the conservative failure preserves program and receipt for recovery.
Uninstall also cannot edit the phone Shortcut: disable or remove it separately
or it can continue placing accepted captures in the Worker after Wordhold is
removed. Reading List and any preserved legacy iCloud handoff are external too.

The clean product-source repository is the only development authority; every
corpus is a different private repository. `build:distribution` and
`package:distribution` are useful lower-level development checks, but a release
producer must use the candidate orchestration below. It binds one reviewed RC
tag and clean `HEAD` to one allowlisted, compiled, ad-hoc-signed archive and one
path-free receipt. In release mode, every distributed source byte must equal
its `HEAD` blob even when Git index flags conceal a working-tree change. Runtime
dependencies are installed inside the new build root from the frozen lockfile
with package scripts disabled; ambient `node_modules` is not release input. The
output directory must not already exist.

Finish and commit all source, tests, and documentation before choosing the RC.
Run the complete local gate, push `main`, require the CI run for that exact
revision to succeed, and only then create and push the RC tag. Build from a
fresh checkout whose `HEAD`, `origin/main`, remote `main`, and remote RC tag all
resolve to that commit. Enable release immutability before creating the GitHub
release. The retained v0.1 input is exact: do not replace it with a rebuild or
fixture.

```sh
(
set -eu
REPOSITORY=adhd/wordhold
RC=v0.5.0-rc.3
RC_STEM=Wordhold-0.5.0-rc.3-darwin-arm64
SOURCE=/absolute/new/path/wordhold-v0.5.0-rc.3-source
RC_OUTPUT=/absolute/new/path/wordhold-v0.5.0-rc.3
ARCHIVE="$RC_OUTPUT/$RC_STEM.tar.gz"
RECEIPT="$RC_OUTPUT/$RC_STEM.receipt.json"
V01_ARCHIVE=/absolute/path/to/retained-Papertrail-0.1.0-darwin-arm64.tar.gz
V01_SHA256=d4e24a228a67de6b3494ce9c2f3bb056528f51952f7022b0b36c381c7be590f1

# In the reviewed canonical worktree, every local gate and status must be clean.
bun run verify:source
bun run verify:licenses
bun test
bun run typecheck
bun run worker:typecheck
bun run compile
test -z "$(git status --porcelain=v1 --untracked-files=all)"
REVISION="$(git rev-parse HEAD)"
git push origin main

# Bind the tag to a successful CI run for this exact pushed revision. A short
# poll handles the normal delay before GitHub creates the run record.
RUN_ID=
for ATTEMPT in $(jot 30); do
  RUN_ID="$(gh run list --repo "$REPOSITORY" --workflow CI --commit "$REVISION" \
    --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  test -z "$RUN_ID" || break
  sleep 2
done
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo "$REPOSITORY" --exit-status
test "$(gh run view "$RUN_ID" --repo "$REPOSITORY" --json headSha --jq .headSha)" = "$REVISION"
test "$(gh run view "$RUN_ID" --repo "$REPOSITORY" --json conclusion --jq .conclusion)" = "success"
git tag -a "$RC" -m "Wordhold $RC"
git push origin "$RC"

# Build and qualify locally from a new clone, never the development worktree.
git clone --branch main https://github.com/adhd/wordhold.git "$SOURCE"
cd "$SOURCE"
git fetch origin tag "$RC"
bun install --frozen-lockfile --ignore-scripts
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(git rev-parse HEAD)" = "$(git rev-parse "$RC^{commit}")"
bun --no-env-file --config=/dev/null run scripts/release-candidate.ts \
  --candidate "$RC" --output "$RC_OUTPUT"
WORDHOLD_RELEASE_ARTIFACT="$RC_OUTPUT/$RC_STEM" \
  PAPERTRAIL_V01_ARCHIVE="$V01_ARCHIVE" \
  bun test tests/guided-setup.test.ts tests/v01-upgrade.test.ts

# The clone-level install supplies the test harness. The release producer performs
# its own locked production-only install inside the isolated build root.

# This repository setting applies to releases published after it is enabled.
gh api --method PUT -H "X-GitHub-Api-Version: 2026-03-10" \
  "repos/$REPOSITORY/immutable-releases"
gh api -H "X-GitHub-Api-Version: 2026-03-10" \
  "repos/$REPOSITORY/immutable-releases"

# The tag must already exist on the remote. Keep the release mutable only while
# its two assets are being qualified.
gh release create "$RC" --repo "$REPOSITORY" --verify-tag --draft \
  --prerelease --latest=false --title "Wordhold $RC" --notes-file /path/to/release-notes.md
gh release upload "$RC" "$ARCHIVE" "$RECEIPT" --repo "$REPOSITORY"

# DRAFT_DOWNLOAD must be a fresh, empty directory. Download assets, never the
# automatic GitHub source archives and never a local copy or cache.
DRAFT_DOWNLOAD=/absolute/new/empty/draft-download
test ! -e "$DRAFT_DOWNLOAD"
mkdir -m 700 "$DRAFT_DOWNLOAD"
gh release download "$RC" --repo "$REPOSITORY" --dir "$DRAFT_DOWNLOAD" \
  --pattern "$RC_STEM.tar.gz" --pattern "$RC_STEM.receipt.json"
cmp "$ARCHIVE" "$DRAFT_DOWNLOAD/$RC_STEM.tar.gz"
cmp "$RECEIPT" "$DRAFT_DOWNLOAD/$RC_STEM.receipt.json"
bun run release:verify-download -- \
  --release-state draft \
  --candidate "$RC" \
  --archive "$DRAFT_DOWNLOAD/$RC_STEM.tar.gz" \
  --receipt "$DRAFT_DOWNLOAD/$RC_STEM.receipt.json" \
  --v01-archive "$V01_ARCHIVE" \
  --v01-sha256 "$V01_SHA256"

# Publish only after the draft download passes. Immutability starts at publish.
gh release edit "$RC" --repo "$REPOSITORY" --draft=false --prerelease
gh release view "$RC" --repo "$REPOSITORY" \
  --json tagName,isDraft,isPrerelease,isImmutable,assets

# FINAL_DOWNLOAD must be another fresh, empty directory. Fetch the published
# assets through public HTTPS with GitHub credential variables removed, then
# repeat cmp and release:verify-download there; do not reuse DRAFT_DOWNLOAD.
FINAL_DOWNLOAD=/absolute/new/empty/published-download
test ! -e "$FINAL_DOWNLOAD"
mkdir -m 700 "$FINAL_DOWNLOAD"
env -u GH_TOKEN -u GITHUB_TOKEN curl -fL --proto '=https' --tlsv1.2 \
  -o "$FINAL_DOWNLOAD/$RC_STEM.tar.gz" \
  "https://github.com/$REPOSITORY/releases/download/$RC/$RC_STEM.tar.gz"
env -u GH_TOKEN -u GITHUB_TOKEN curl -fL --proto '=https' --tlsv1.2 \
  -o "$FINAL_DOWNLOAD/$RC_STEM.receipt.json" \
  "https://github.com/$REPOSITORY/releases/download/$RC/$RC_STEM.receipt.json"
cmp "$ARCHIVE" "$FINAL_DOWNLOAD/$RC_STEM.tar.gz"
cmp "$RECEIPT" "$FINAL_DOWNLOAD/$RC_STEM.receipt.json"
bun run release:verify-download -- \
  --release-state published \
  --candidate "$RC" \
  --archive "$FINAL_DOWNLOAD/$RC_STEM.tar.gz" \
  --receipt "$FINAL_DOWNLOAD/$RC_STEM.receipt.json" \
  --v01-archive "$V01_ARCHIVE" \
  --v01-sha256 "$V01_SHA256"
)
```

Require the published view to report the expected tag, `isDraft: false`,
`isPrerelease: true`, `isImmutable: true`, and exactly the two expected assets
with their expected sizes. Never use `--clobber`, move a published RC tag, or
replace/delete a published asset. A byte change requires a new RC identifier
and the complete qualification sequence.

After that published download passes, the honest state is **PUBLIC RC
QUALIFIED**. It proves the public remote round trip and the automated artifact,
clean-install, compatibility-update, and local-core lifecycle gates. It does not
prove browser quarantine behavior, broad macOS compatibility, or any optional
live account/device integration. A maintainer may record one real browser
download and Gatekeeper observation, but that observation does not block public
source or an explicitly experimental ad-hoc RC. If this candidate is later
promoted to final `v0.5.0`, the final tag must point to the same source revision
and use the archive and receipt from the final verified published-RC download
under their existing names. Do not rebuild, repackage, edit, or rename them. A
final release from different bytes must first qualify as a new RC.

The packager verifies the artifact, refuses to overwrite an archive, and
normalizes tar owner/group metadata so the builder's account name is not leaked.
The receipt binds the archive name, size, SHA-256, source revision, internal
release id, target, and toolchain. The receipt, GitHub asset digest, and
extracted manifest prove exact identity and inventory within the canonical
GitHub channel. Ad-hoc signing catches malformed executable signatures but
supplies no publisher identity and does not replace Developer ID or
notarization. Users who do not accept that boundary should build the public
source.

## Normal commands

```sh
printf '%s' '{"input":"context https://example.com/article","idempotencyKey":"caller-owned-id"}' | "$WORDHOLD" capture --json
"$WORDHOLD" capture 'https://example.com/article'
"$WORDHOLD" recent
"$WORDHOLD" search 'terms'
"$WORDHOLD" show pt_...
"$WORDHOLD" health
PAPERTRAIL_ROOT="$DATA" "$APP/current/bin/papertrail-daemon"
PAPERTRAIL_ROOT="$DATA" "$APP/current/bin/papertrail-enrich"
PAPERTRAIL_ROOT="$DATA" "$APP/current/bin/papertrail-digest"
PAPERTRAIL_ROOT="$DATA" "$APP/current/bin/papertrail-resurface"
```

For the ordinary one-shot drain, use `"$WORDHOLD" drain`. The individual
compiled job commands above are advanced operations. They keep all mutable state
under `$DATA`; no database, inbox, log, or corpus file belongs under immutable
`$APP/current`. `bun run …` forms elsewhere in this guide are development or
private Worker-deployment commands, never installed setup commands.

After an ordinary Mac reboot, log into the same macOS account. If scheduling is
installed, macOS loads the Wordhold user LaunchAgents automatically; the
daemon runs at load and then on its five-minute interval. Do not open Terminal,
Wordhold, or Codex merely to start a scheduled drain. A Mac that is off or
asleep defers Safari synchronization and processing until it wakes; use health
if the daemon remains stale after login. Without scheduling, run
`"$WORDHOLD" drain` deliberately.

`wordhold capture` returns one JSON receipt with `status: "queued"`, a queue id, and
the normalized kind/URL. Queued means the request is atomically present in
`inbox/raw/`; it becomes archived only after the daemon creates a scoped Git
commit. Agents should use JSON on stdin for highlights, explicit URL choices,
or text containing shell punctuation. No Worker secret belongs in the command,
stdin payload, or receipt.

### iPhone online-client truth and removal

The active **Save to Papertrail — Online** Shortcut sends one URL directly to
the optional Worker. `Accepted by Papertrail: in_…` proves durable remote
queueing, not canonical archival. The Mac may be off at capture time; a later
successful daemon commit and structured retrieval prove the local archive.
Without phone internet, the Shortcut has no fallback and cannot show success.
The request contains only `{url}` and no caller idempotency key. A repeated
successful gesture can therefore create another Worker row, although canonical
URL identity makes local ingestion converge rather than create duplicate items.
Automatic draining additionally requires the Worker inbox capability and
Wordhold scheduling; otherwise use `"$WORDHOLD" drain`.

```sh
"$WORDHOLD" iphone status
"$WORDHOLD" iphone shortcut clear-token
"$WORDHOLD" iphone disable
```

`iphone status` reports the bundled offer version/name, exact offered versus
approved digest state, and whether the last setup proved a capture-only
HTTPS/Keychain reference. `approval_required`, `approved`, `update_available`,
and `repair_required` describe local artifact bookkeeping only.
`repair_required` means the active artifact no longer matches its stored offer;
rerun `iphone setup`, re-import or update the exact offered artifact, and then
approve it. `state: blocked` with `worker: drain_unconfigured` means the
resolved local Worker capability, origin, or admin-secret reference no longer
matches the online client. Restore that matching drain, rerun setup, then
re-import/update and approve. Status is a local configuration check; remote
credential drift appears in Worker health or the next setup/copy-token check.
`liveDevice` remains `unknown`; Mac inspection cannot prove Share Sheet
visibility or a successful phone gesture. Worker health and the corpus remain
separate facts.

The `legacyIcloud` object reports preserved 0.3.x local-file state for recovery.
Its `ready/queued/stale/unavailable/changed` values refer only to the old Mac
iCloud folder, not the online Worker queue. The old workflows remain withdrawn
and were not imported into this public history; they are not active
alternatives. If old ingestion must be disabled after its queued evidence is
handled, use `iphone legacy-icloud disable`; that operation does not change the
online client.

`iphone disable` removes only the local online-client reference. It does not
delete the Shortcut from the phone, erase the Keychain item, revoke the Worker
credential, delete queued rows, touch legacy iCloud evidence, or alter the
corpus. Delete the phone Shortcut separately. Revoke or rotate
`CAPTURE_SECRET` when it should no longer authorize any client, then remove the
Keychain item if no longer needed.

With `imessage.dryRun=true`, digest/resurfacing write `logs/outbox.log`; a resurfacing preview does not consume passages. Runtime logs are under `logs/`. Cloudflare sender quarantine metadata is `logs/quarantine.jsonl`. Never paste `.env`, populated config, or raw private newsletter bodies into an issue or chat.

The maintainer-only one-shot live acceptance command is
`PAPERTRAIL_ROOT="$DATA" PAPERTRAIL_LIVE_VERIFY=1 bun run verify:live-imessage`
from a clean product source checkout with dependencies installed. It is not an
installed runtime command. It sends exactly one real digest from a temporary seeded paywall corpus
and deletes that corpus afterward; the persistent config remains dry-run.
Without the explicit environment gate, the command refuses to send.

## What “healthy” means

- `"$WORDHOLD" health` shows exact last-run/last-success timestamps for `local_capture`, `worker_inbox`, `icloud_inbox`, `reading_list`, the daemon job, enrichment, resurfacing, and digest. `NEVER RUN`, `STALE`, setup notes, and failures are non-healthy; email senders also get event rows after ingestion. The command exits **0 only for healthy aggregate state** and nonzero otherwise, so automation must check its exit status rather than grep for a reassuring line.
- `git log --oneline` contains scoped `daemon:` and `enrichment:` commits. A missing runtime commit with a growing queue means processing or git failed before acknowledgement.
- `inbox/raw/` is normally empty shortly after a successful drain. Files there are retained work, not garbage; never bulk-delete them.
- `logs/bad-captures/` contains malformed iCloud Shortcut files moved out of the live drain without deletion. A same-name prior evidence file is never overwritten; the later capture receives a numeric suffix. When iCloud cannot rename across volumes, Wordhold streams the bytes into a private fsynced atomic destination instead of buffering the hostile file or relying on macOS `copyfile`, and removes the source only after that write succeeds. `logs/bad-worker-captures.jsonl` records malformed remote row ids/reasons without copying their payloads; those rows remain unacknowledged. Correct the producing Shortcut or deployment before deciding how to recover them.
- `logs/*.stderr.log` from the LaunchAgents are quiet. `logs/daemon.log` explains bounded per-item failures.
- The weekly digest reports source staleness and failed/unfetched titles. Reading List staleness can be an iCloud sync issue; open Safari on the Mac, then verify Safari is enabled in iCloud settings.

Safari Reading List is an ambient append-only import, not a drainable queue. Every five-minute pass returns every current entry and its adapter acknowledgement is intentionally a no-op. Repeated log lines such as `18 pulled, 18 processed, 18 acked` are therefore normal; canonical URL identity makes them no-op replays, and only genuinely new material creates another `daemon:` commit. Never optimize this by treating a missing Reading List entry as a Wordhold deletion.

Staleness thresholds match the installed schedules: 15 minutes for five-minute source draining and the daemon heartbeat, 26 hours for nightly enrichment/daily resurfacing, and eight days for the weekly digest. Raw-spool files and writer intents use the same simple 15-minute threshold based on local file modification time; 15 minutes exactly is still fresh, while 16 minutes is degraded. A recorded commit/ack failure is immediately visible on the affected source before that age rule matters. A missing Worker URL, iCloud directory, or Reading List plist is recorded as setup-needed health even though the adapter safely returns no captures. `email:<sender>` rows are event history and have no periodic stale threshold.

## Updating code

From a clean understanding of the repo status (do not discard unrelated work):

```sh
bun install
bun test
bun run typecheck
bun run worker:typecheck
bun run compile
bun run verify:source
```

Build and test a clean artifact, then exercise its guided update path. That path
refreshes verified LaunchAgents; check/re-grant Full Disk Access only when
Reading List is enabled. Agent integration and Worker deployment are separate.
Apply new D1 migrations before code that depends on them; after deploying this
version, mirror any existing D1 allowlist into R2:

The compiled daemon embeds `core/schema.sql`; it must start without reading a source-relative schema path. Scheduled compiled jobs receive `PAPERTRAIL_APP_ROOT` so versioned prompts and other assets resolve from the active release. `tests/launchd.test.ts` is the packaging regression. If launchd logs mention `/$bunfs/.../schema.sql` or `/$bunfs/.../agent/prompts`, rebuild, reinstall, and reconcile the LaunchAgents before trusting that job.

Run Cloudflare commands only from the installation owner's separate private Worker
deployment workspace. A built artifact places the generic config at
`worker/wrangler.toml`; populate that file in the private workspace and keep its
resource identifiers and provider state there. Existing Papertrail deployments
retain their current Worker/resource names. Fresh deployments may keep or
replace the template's `wordhold-worker` name before the first deploy:

```sh
cd /absolute/path/to/private-wordhold-worker
bunx wrangler d1 migrations apply YOUR_D1_DATABASE --remote --config worker/wrangler.toml
bunx wrangler secret put CAPTURE_SECRET --config worker/wrangler.toml
bunx wrangler deploy --config worker/wrangler.toml

cd /absolute/path/to/private-wordhold-worker
PAPERTRAIL_ROOT="$DATA" bun run worker:sync-senders
```

Migration `0003_capture_notes.sql` must land before deploying the unified note
route. `CAPTURE_SECRET` is a capture-client credential and must differ from the
admin `SECRET`. The shared online Shortcut artifact contains no credential, but
its personalized installed copy does. Rotate the value in Cloudflare and
Keychain, rerun `iphone setup`, then copy the new token into the installed
Shortcut or re-import the exact offered artifact. That setup run invalidates
the prior local approval; after updating the phone, conditionally clear the
clipboard with `iphone shortcut clear-token` and record the new confirmation
with `iphone shortcut approve`. Keychain rotation alone does not update the
phone. The Mac daemon and admin operations continue using
`PAPERTRAIL_SECRET`. The sync endpoint is admin-authenticated and stores only
normalized sender markers, never secrets.

## Rebuild after SQLite loss or disagreement

Canonical Markdown and the resurfacing journal win. Stop relying on the suspect DB, preserve it if diagnosis matters, then run:

```sh
"$WORDHOLD" rebuild
"$WORDHOLD" search 'known seeded phrase'
"$WORDHOLD" health
```

The rebuild restores items, stable ids, URL aliases, highlights, FTS, and resurfacing state. It replaces corpus tables in one SQLite transaction. If any canonical file is malformed, the command names its path, rolls back, and leaves the prior complete index searchable but stale. The daemon records `job:daemon` failure and stops before pulling, canonical mutation, commit, or acknowledgement. Preserve the file, compare it with Git/source evidence, and repair or restore that exact canonical file; never guess from SQLite. Rerun rebuild and the known search before restarting normal drains. Source health is operational state and is not erased by a normal rebuild. Do not hand-edit SQLite to “fix” a Markdown disagreement.

Rebuild also participates in canonical writer recovery. If it finds a merge interrupted by the daemon, it finishes the winner/loser file transition and creates a scoped `maintenance: recover canonical writes` commit before clearing the daemon writer intent. If that commit fails, the intent remains for retry; do not delete it by hand.

## Acknowledgement/restart recovery

If the daemon dies after local commit but before upstream acknowledgement, the Worker row or iCloud file and `inbox/raw/` remain. Run the daemon again. URL/highlight idempotency should produce no duplicate, then acknowledge and remove the spool. Do not manually delete either copy.

If canonical Markdown was replaced but SQLite missed its update, the next daemon startup rebuilds the derived DB before processing. If git commit fails, upstream captures remain unacknowledged and the log says so.

One malformed `inbox/raw/<hash>.json` no longer blocks independent valid work. Its original bytes remain untouched, `raw_spool` health stays failed, and valid records still follow commit-before-acknowledgement. To recover it, first copy/preserve the original for review, determine the intended capture from source evidence, and replace or requeue only a valid complete `{version:1,adapterName,capture}` record. The next pass processes it idempotently and removes it only after required acknowledgement. Never bulk-delete the spool or fabricate missing fields merely to make health green.

A transient article fetch does not retain the upstream capture after its first committed attempt. Instead, the item remains `captured` with its attempt count and error in canonical Markdown. Each later daemon pass retries a bounded batch before pulling sources until extraction succeeds or `enrichment.maxFetchAttempts` changes it to `fetch_failed`. This prevents both permanent one-time failures and retry backlogs monopolizing a run.

`forbidden_url` and `redirect_forbidden` are deliberate terminal safety results: Wordhold only fetches public HTTP(S) reading URLs. Production resolves each hop once and pins the actual connection to a vetted public address while retaining the original Host/SNI; this prevents a second DNS lookup from rebinding to a local address. Do not make local/private hosts fetchable to clear those errors. Correct or remove the bad capture instead.

## Backup set and restore proof

Runnable recovery requires two compatible components: (1) a **completed private data-Git snapshot** containing canonical `items/`, `agent/tags.md`, and tracked `logs/resurfacing.jsonl` / `logs/new-tags.jsonl`; and (2) the exact sanitized program release, or a newer release demonstrated compatible with that data. A copied live SQLite file or loose working tree is not the proof. `papertrail.db*` is derived; `source_health` may honestly reset.

Git-only backup excludes ignored `inbox/raw/`, `inbox/merges/`, and `inbox/writer-intents/`. That creates this loss window:

- acknowledged canonical work after the newest backed-up commit can be lost with the Mac;
- unacknowledged Worker/iCloud work may still be upstream and replayable;
- local-only queued work is lost unless the chosen snapshot also includes the ignored inbox;
- `.env`, populated config, Keychain credentials, the personalized phone
  Shortcut, launchd, FDA/Messages permissions, Safari or preserved legacy
  iCloud setup, and Cloudflare resources must be protected or re-created
  separately.

To bind a restored private data repository to a verified compiled release,
leave all upstreams and scheduling off until local retrieval succeeds. Point
`DATA` at the restored Git worktree and `RELEASE` at the freshly verified,
unpacked Wordhold artifact. Do not overwrite a recovered real config:

```sh
DATA=/absolute/path/to/restored-private-data
INSTALL_ROOT=/absolute/path/to/new-program-root
RELEASE=/absolute/path/to/verified-unpacked-wordhold

test -d "$DATA/.git"
git -C "$DATA" fsck --full --strict
if test ! -e "$DATA/papertrail.config.json"; then
  install -m 600 "$RELEASE/papertrail.config.example.json" \
    "$DATA/papertrail.config.json"
fi
cd "$RELEASE"
./wordhold setup --install-root "$INSTALL_ROOT" --data-root "$DATA"
WORDHOLD="$INSTALL_ROOT/bin/wordhold"
"$WORDHOLD" rebuild
"$WORDHOLD" recent
"$WORDHOLD" health
```

The shipped example config keeps every optional edge disabled. Confirm a known
item and search result before recreating the private config, `.env`, Keychain
items, Worker bindings, phone Shortcut, permissions, or schedules. Once those
are restored deliberately, run the relevant health check before allowing an
upstream drain. This recovery branch is exercised by the packaged lifecycle
test; off-machine durability still requires the separate evidence below.

Maintainers can run the non-networked same-Mac mechanics proof from a clean
product-source checkout pinned to the installed manifest's exact
`source.revision`, with Bun and dependencies installed:

```sh
cd /absolute/path/to/wordhold-source
PAPERTRAIL_ROOT="$DATA" bun run scripts/verify-local-restore.ts "$DATA"
```

It uses that pinned program source to clone the data repository's `HEAD` without
hardlinks into a temporary directory, confirms the source/restored commit, runs
`git fsck --full --strict`, requires no ambient database, rebuilds, compares a
canonical body hash, and verifies a known FTS result. It proves that data
snapshot against the matching program revision, not a self-contained
code-and-data commit. An unpinned checkout is only a compatibility smoke test.
The command deletes the temporary restore and reports only commit/count/timing,
not private text. This does not prove off-machine durability.

Before calling Mac-loss recovery complete, restore an approved **completed encrypted off-machine snapshot** into a fresh location and, without starting the daemon or contacting any upstream, record: snapshot time; newest included canonical commit; whether ignored in-flight state was included; uncovered work; encryption evidence as tool-observed or user-attested; and restore duration. Run Git integrity and the local restore proof against that restored repository. Only after corpus/search proof should config/Keychain, Cloudflare, the personalized phone Shortcut, Safari/iCloud, launchd, FDA, and Messages be provisioned and normal drains enabled. Current destination/proof status belongs in private operator evidence; a local clone is never relabeled as backup.

## Private-state classification

| Class | Paths | Git policy / recovery role |
| --- | --- | --- |
| Canonical/tracked data | `items/**/*.md`, `agent/tags.md`, `logs/resurfacing.jsonl`, `logs/new-tags.jsonl` | Deliberately tracked in the private data repository; pair its completed snapshot with a compatible sanitized program release |
| Derived | `papertrail.db`, `papertrail.db-wal`, `papertrail.db-shm` | Ignored; rebuild, health may reset |
| In flight | `inbox/raw/`, `inbox/merges/`, `inbox/writer-intents/`, transient writer lock | Ignored private recovery evidence; inclusion changes RPO |
| Runtime evidence | ordinary `logs/*.log`, `logs/bad-captures/`, Worker invalid/quarantine/oversize JSONL and seen files | Ignored; preserve relevant evidence, never broad-stage |
| Credentials/config | `.env`, populated `papertrail.config.json`, Keychain credentials | Ignored or external; re-create/protect separately, never print values |

New Wordhold private directories/files use `0700`/`0600`, SQLite creation is owner-only, quarantined moved files are narrowed to `0600`, and LaunchAgents use umask `077`. Existing paths are not silently chmodded by ordinary startup; their exact audit and any pending operator-approved correction live in private operator evidence. Git checkout does not preserve private read modes, so the enclosing repository boundary remains necessary. `.gitignore` protects ordinary status/staging only; a deliberate `git add -f` can still include private data and is forbidden by policy.

## Worker or newsletter trouble

- **Daemon gets 401:** local `PAPERTRAIL_SECRET` and deployed Worker `SECRET` disagree. Rotate deliberately in both places; do not log either value.
- **Phone gets 401:** its personalized token does not match deployed `CAPTURE_SECRET`. Rotate the capture secret and update the installed Shortcut; leave the daemon/admin secret alone.
- **Capture-only token gets 403 from drain/body/ack/allow/admin:** this is the intended least-privilege boundary. The active phone Shortcut calls only `POST /v1/save`.
- **Worker unreachable:** other adapters continue; the Worker queue remains durable. Restore/deploy Worker, then drain normally.
- **Large Worker backlog:** one run is deliberately bounded to 200 accepted captures, 20 metadata pages, 64 MiB of hydrated email responses, and 30 seconds for each complete response including its body stream. Each metadata response is capped at 2 MiB. Deferred rows remain unacknowledged and drain on later intervals. R2-only recovery scans rotate through the full pending prefix with a small durable cursor rather than repeatedly inspecting the first 200 keys. Look for `body budget reached` or `page budget reached` in the Worker adapter log; do not increase every bound at once.
- **Oversized Worker body:** the adapter cancels a single body as it crosses 64 MiB, records metadata in `logs/oversized-worker-bodies.jsonl`, and remembers its id in `logs/oversized-worker-bodies-seen.txt`. The remote row is not acknowledged, but it no longer starves later rows or consumes bandwidth every five minutes. Recover or remove the remote row deliberately; only then remove that exact id from the seen file if it should be attempted again.
- **D1 outage during mail:** a self-contained `email-pending/` record already holds the parsed body and queue metadata in R2. The next successful `/v1/drain` promotes it into D1. Already-indexed records are checked by id without downloading their large R2 bodies again.
- **Interrupted/concurrent newsletter acknowledgement:** `email-acked/` tombstones are the durable ordering markers. They are intentionally retained and tiny. Do not delete them to tidy the bucket; a tombstone prevents an in-flight recovery from resurrecting an acknowledged row.
- **Unknown sender:** inspect `$DATA/logs/quarantine.jsonl`, then from the separate private Worker deployment workspace run `PAPERTRAIL_ROOT="$DATA" bun run worker:allow sender@example.com` only for the exact verified SMTP envelope address, and drain. A differing RFC `From` header is display metadata and never authorization. Quarantine lives only in D1; a trigger atomically retains the 50 newest rows. Unknown input is read to at most 1 MiB, but only a complete serialized message of at most 32 KiB is retained inline and can drain after allowlisting. Larger mail is metadata-only, carries `quarantine_body_too_large` or `quarantine_payload_too_large`, degrades Worker health, and must be resent after approval. Accepted-sender bodies alone use R2. Upgrade recovery also checks old D1 `bodyKey` rows whose R2 object has already vanished; it will not release one into a permanent body-fetch failure. If `legacy_quarantine_requires_resend` appears, approve the sender and request a resend.
- **Sender authorization unavailable:** every verified allow operation has an R2 marker fallback. From that private Worker deployment workspace, run `PAPERTRAIL_ROOT="$DATA" bun run worker:sync-senders` after upgrading an older deployment. If neither D1 nor the marker can establish authorization, the email invocation fails visibly rather than treating a possibly known large sender as unknown and dropping its body.
- **Large email:** body is in R2, not D1. Never “fix” a large-message issue by truncating it; `tests/worker-email.test.ts` is the regression contract.

## Shortcut capture trouble

The active 0.4.0 Shortcut graph accepts Share Sheet Text, URL, or Safari Web
Page input only to extract URLs. The bounded live qualification covers sharing
one Safari page; other Share Sheet providers are not live-qualified. Exactly
one URL must remain. `Papertrail needs exactly one web
URL.` means it stopped before networking. It posts that URL to the personalized
`/v1/save` endpoint with the personalized capture-only bearer token. A native
network error is not success. `Papertrail did not return a valid queue receipt.`
means the response lacked an `id` beginning with `in_`.

Troubleshoot the active path in this order:

1. Confirm the shared input exposes exactly one public HTTP(S) URL.
2. Confirm the installed endpoint is the full HTTPS `/v1/save` URL and the
   installed token matches the current `CAPTURE_SECRET`. Rerun `iphone setup`
   with the Worker origin only—no path, query, fragment, or embedded
   credential—to re-verify least privilege without printing the secret; this intentionally
   invalidates prior approval until the phone answers are updated and approved.
3. Require `Accepted by Papertrail: in_…` before treating the gesture as remotely
   queued. The notification does not prove a Mac commit.
4. Check `wordhold health` for `worker_inbox` and the daemon, then run
   `"$WORDHOLD" drain` if scheduling is absent or a bounded manual check is
   needed.
5. Confirm the scoped `daemon:` commit and retrieve the stable item id. Do not
   repeat-share merely because local retrieval is delayed; another gesture can
   create another remote row.

The Worker applies the shared capture payload bounds and public-URL policy. The
online Shortcut does not send a title, selected text, timestamp, or
`idempotencyKey`, and it cannot create a note or highlight. Editing its endpoint
or token is installation personalization; any graph or behavior change creates
a new candidate and invalidates the existing artifact digest and approval.

### Historical local-file recovery only

The 0.3.5 generated workflow and the 0.3.6 and 0.3.7 Apple-authored workflows
are withdrawn and must not be run. Their historical device trials did not
qualify a supported local-file capture path.

Preserved legacy files remain recovery evidence. The old adapter accepts its
documented legacy envelopes and quarantines settled malformed candidate files
under `logs/bad-captures/`; this compatibility does not make any old Shortcut a
supported input. Never move rejected evidence back into the live queue or
delete it to make status appear healthy. Review and copy exact bytes under a
fresh valid recovery identity only when a deliberate operator recovery is
justified.

## Hermes capture trouble

Run `hermes skills list --enabled-only` and confirm `papertrail` is enabled.
Run `hermes mcp test papertrail` and confirm the six tools are discovered.
Refresh the real MCP entry and generic skill with `"$WORDHOLD" connect hermes`.
The installer refuses a differing managed
entry or skill; inspect/remove the old entry deliberately instead of silently
retargeting another corpus. Hermes uses `queue_capture` only for explicit save
requests. A queued file stuck in `inbox/raw/` is daemon/Git trouble, not a
reason to give Hermes a Worker secret.

## Reading List and iMessage trouble

`EPERM`/`EACCES` reading `Bookmarks.plist` is setup failure, not an empty list. Grant Full Disk Access to the exact compiled path in `docs/setup.md`. Byte-identical scheduled-daemon updates leave that stable executable untouched, but health must still be checked after every update; re-grant whenever the runtime reports denial.

Messages error `-1743`, “not allowed,” or “not authorized” means macOS Automation is blocked. Enable the relevant Wordhold/Bun executable under **Privacy & Security > Automation**. Alerts also log a delivery failure so source processing can continue.

## Enrichment trouble

Run `codex login status`. Enrichment executes `codex exec` ephemerally in an empty temporary directory, with a read-only sandbox, fixed output schema, two-minute subprocess timeout, ten-minute job budget, and no inherited `OPENAI_API_KEY`. Inference does not hold the canonical writer lock. Clean items run before retries. A malformed response gets one schema nudge; parse and runner failures are recorded as `enrichment_*_failed:N`, and the third failure retires the item as `fetch_failed`. Correct the prompt/source issue and deliberately restore `status: has_body` plus clear `last_error` in canonical Markdown if it deserves another attempt, then run `"$WORDHOLD" rebuild`. Non-verbatim highlight proposals are dropped. Never loosen those guards to make a batch appear successful.

## Resurfacing replies

Messages display exact `hl_…` ids. Route a reply such as `skip hl_abc123def4` through `PAPERTRAIL_ROOT="$DATA" "$APP/current/bin/papertrail-resurface" --reply '<text>'`. Retirement is an append-only journal event and survives DB rebuild. To undo an accidental retirement, append an `unretired` event through a reviewed code/CLI change; do not edit old journal lines.
