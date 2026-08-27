# Operations and recovery

Wordhold is intended to run without routine human upkeep. Use this guide to
operate an installed system, update or remove it, prove a backup, or recover
from a failure. Start with [Setup](setup.md) for a first installation. Release
authors should use [Release verification](release-verification.md), not this
operator guide.

Wordhold 0.5 retains the Papertrail machine namespace used by earlier releases.
The paths and identifiers below are therefore intentional compatibility
contracts. Update an existing installation in place; do not create parallel
Wordhold-named data, LaunchAgent, MCP, Keychain, Worker, or Shortcut state. A
fresh optional Worker may use the Wordhold template name documented below.

Commands in this guide use the default roots below. If setup used custom roots,
replace them here before running any operational command. These values govern
update, removal, queue, backup, and recovery examples; the shell does not
discover a custom installation automatically.

```sh
APP="$HOME/Library/Application Support/Papertrail/app"
DATA="$HOME/Library/Application Support/Papertrail/data"
WORDHOLD="$APP/bin/wordhold"
test -x "$WORDHOLD"
test -d "$DATA/.git"
```

## Install, update, or remove the program

Install and update only from the canonical GitHub release after its receipt and
complete archive SHA-256 agree. That same-channel check establishes release
integrity, not independent publisher identity. The adjacent manifest then
checks exact inventory, file hashes, executable modes, and host compatibility
during lifecycle operations:

For a first installation:

```sh
(
set -eu
cd /path/to/unpacked-wordhold-artifact
./wordhold setup
)
```

For an update, use the newly unpacked release:

```sh
(
set -eu
cd /path/to/unpacked-new-wordhold-artifact
./wordhold update
)
```

If setup used a custom program root:

```sh
(
set -eu
cd /path/to/unpacked-new-wordhold-artifact
./wordhold update --install-root /absolute/custom/program/root
)
```

To remove the installed program, verified scheduling, and any unchanged
Wordhold-managed Codex/Hermes registration or Hermes skill:

```sh
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
pointer, receipt, verified LaunchAgents, and unchanged managed client state. It
refuses before deleting program files if an owned member changed unexpectedly.
It preserves the separate data root, private Git history, queues, configuration,
credentials, phone Shortcut, Reading List, legacy iCloud evidence, and remote
resources. That makes `uninstall` program removal, not data erasure or full
decommissioning.

Release production, tagging, GitHub publication, remote qualification, and
promotion are maintainer-only work. The complete procedure and its immutable
release rules live in [Release verification](release-verification.md).

## Read and inspect

```sh
"$WORDHOLD" recent
"$WORDHOLD" search 'terms'
"$WORDHOLD" show pt_...
"$WORDHOLD" health
```

## Queue and drain

Each command below changes local state. Queue one URL or use the JSON form when
the input needs an explicit intent, URL choice, context, or idempotency key:

```sh
"$WORDHOLD" capture 'https://example.com/article'
```

```sh
printf '%s' '{"input":"context https://example.com/article","idempotencyKey":"caller-owned-id"}' | "$WORDHOLD" capture --json
```

For an exact manual highlight attached to a page, make the selected passage the
`input`, declare the intent, and supply that page's public URL:

```sh
printf '%s' '{"input":"Exact selected passage.","intent":"highlight","url":"https://example.com/article","title":"Article title","idempotencyKey":"caller-owned-selection-id"}' | "$WORDHOLD" capture --json
```

Then run the ordinary one-shot drain with `"$WORDHOLD" drain`, or let installed
scheduling do it. Queued means the request is atomically present in
`inbox/raw/`; it becomes archived only after the daemon creates a scoped Git
commit. No Worker secret belongs in the command, stdin payload, or receipt.

The individual compiled jobs are advanced operations. Run only the intended
one: enrichment may disclose a selected full body to OpenAI, while digest and
resurfacing may send Messages unless configured for dry-run. Their binaries are
`$APP/current/bin/papertrail-enrich`,
`$APP/current/bin/papertrail-digest`, and
`$APP/current/bin/papertrail-resurface`. Direct invocation must supply both the
private data root and active application root required by packaged assets. For
example, to run enrichment after checking its capability and disclosure:

```sh
PAPERTRAIL_ROOT="$DATA" \
  PAPERTRAIL_APP_ROOT="$APP/current" \
  "$APP/current/bin/papertrail-enrich"
```

Use the same two environment variables with either other job only after
checking its output configuration. All mutable state stays under `$DATA`; no
database, inbox, log, or corpus file belongs under immutable `$APP/current`.
`bun run …` forms elsewhere in this guide are development or private
Worker-deployment commands, never installed setup commands.

### Digest and resurfacing effects

The weekly digest deterministically summarizes the previous seven days of
arrivals and source counts, a bounded manual-first highlight sample, repeated
tags, failed or unfetched items, source health, and new tag definitions. It does
not ask a model to invent a narrative.

Daily resurfacing selects up to three highlights older than 30 days, preferring
manual highlights two-to-one over AI highlights and prioritizing never- or
least-recently-shown passages. A successful live send journals a `shown` event;
after five sends that highlight leaves the pool. Dry-run writes the preview to
the private outbox without journaling it as shown. A later `skip hl_…` or `stop
hl_…` reply passed through the rooted command under [Resurfacing
replies](#resurfacing-replies) journals retirement. Both jobs use Messages when
live, so inspect dry-run output before changing `imessage.dryRun` to `false`.

After an ordinary Mac reboot, log into the same macOS account. If scheduling is
installed, macOS loads the Wordhold user LaunchAgents automatically; the
daemon runs at load and then on its five-minute interval. Do not open Terminal,
Wordhold, or Codex merely to start a scheduled drain. A Mac that is off or
asleep defers Safari synchronization and processing until it wakes; use health
if the daemon remains stale after login. Without scheduling, run
`"$WORDHOLD" drain` deliberately.

`wordhold capture` returns one JSON receipt with `status: "queued"`, a queue id,
and the normalized kind and URL. Agents should use JSON on stdin for highlights,
explicit URL choices, or text containing shell punctuation.

### iPhone online-client truth and removal

The optional online Shortcut sends one URL to the Worker. Its acceptance
message proves remote queueing, not a local archive. The Mac may be off during
capture; the daemon commits the item after the Mac returns. There is no offline
phone fallback. The complete artifact and receipt contract is in
[Save to Papertrail — Online](../integrations/shortcuts/Papertrail.md).

```sh
"$WORDHOLD" iphone status
```

`iphone status` reports the offered and approved artifact state plus the last
local setup proof. It cannot inspect the phone, prove Share Sheet visibility,
or detect every remote credential change. `repair_required` means the active
release's bundled Shortcut no longer matches the offer stored by the last
successful setup or update. `update_available` means the stored offer differs
from the artifact the owner last approved. A blocked Worker drain means the
local Worker configuration no longer supports the online client. Repair the
reported prerequisite, rerun `iphone setup`, update the phone, and approve the
exact offered artifact.

The `legacyIcloud` status concerns preserved recovery evidence, not the online
queue. The withdrawn workflows are not supported capture methods. See
[Legacy iCloud recovery](#legacy-icloud-recovery) before changing that state.

To remove only the local online-client reference:

```sh
"$WORDHOLD" iphone disable
```

The command does not delete the Shortcut from the phone, erase the Keychain
item, revoke the Worker
credential, delete queued rows, touch legacy iCloud evidence, or alter the
corpus. Delete the phone Shortcut separately. Revoke or rotate
`CAPTURE_SECRET` when it should no longer authorize any client, then remove the
Keychain item if no longer needed.

## Decommission a deployment

Do not treat program uninstall as data deletion. A full decommission crosses
several independent boundaries and should be deliberate:

1. Drain or account for every local and remote queue, check health, and complete
   a [verified backup](#create-and-verify-a-backup).
2. Disable each capture edge. Delete the phone Shortcut and revoke its capture
   credential; remove [managed agent integrations](integrations.md#install-verify-and-remove);
   disable Reading List and any legacy iCloud handoff that is no longer needed.
3. Run `"$WORDHOLD" uninstall` to remove the installed program and its owned
   schedules. Resolve any refusal instead of deleting installation files by
   hand.
4. Delete optional Worker, D1, R2, and email-routing resources only after their
   pending work and recovery evidence are accounted for.
5. Keep the private data repository unless the owner separately chooses to
   destroy it after a successful restore proof. Wordhold supplies no automatic
   corpus-erasure command.

Credentials in macOS Keychain and service dashboards are external state. Revoke
them where they are authoritative; deleting a local reference alone does not
revoke access.

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

## Optional Worker deployment updates

This section applies only when the optional Cloudflare Worker is enabled. A
normal program update does not deploy it. Run Cloudflare commands from the
owner's separate private Worker workspace, where populated bindings and
provider state remain untracked. Read the release notes first and apply required
D1 migrations before deploying code that depends on them:

```sh
(
set -eu
cd /absolute/path/to/private-wordhold-worker
bunx wrangler d1 migrations apply YOUR_D1_DATABASE --remote --config worker/wrangler.toml
bunx wrangler deploy --config worker/wrangler.toml
PAPERTRAIL_ROOT="$DATA" bun run worker:sync-senders
)
```

Migration `0003_capture_notes.sql` must land before deploying the unified note
route. An ordinary deployment update does not rotate either credential.

When deliberately rotating `CAPTURE_SECRET`, be ready to update the phone
before running this separate command:

```sh
(
set -eu
cd /absolute/path/to/private-wordhold-worker
bunx wrangler secret put CAPTURE_SECRET --config worker/wrangler.toml
)
```

The capture credential must differ from admin `SECRET`. Replace the matching
Keychain value, rerun `iphone setup`, update the phone's personalized Shortcut,
clear any copied token, and approve the exact offered artifact. Keychain
rotation alone does not update the phone. The Mac daemon continues to use the
separate admin credential.

## Rebuild after SQLite loss or disagreement

Canonical Markdown and the resurfacing journal win. If SQLite still opens but
its derived contents disagree, run:

```sh
(
set -eu
"$WORDHOLD" rebuild
"$WORDHOLD" search 'known seeded phrase'
)
```

If SQLite cannot open, stop any scheduled or manual daemon first. Run
`"$WORDHOLD" unschedule` if scheduling was installed. Preserve the exact derived
files under still-ignored names, then rebuild a fresh index:

```sh
(
set -eu
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
for db_name in papertrail.db papertrail.db-wal papertrail.db-shm; do
  source_file="$DATA/$db_name"
  preserved_file="$source_file.before-rebuild-$STAMP"
  if test -e "$source_file"; then
    test ! -e "$preserved_file"
    mv "$source_file" "$preserved_file"
  fi
done
"$WORDHOLD" rebuild
"$WORDHOLD" search 'known seeded phrase'
)
```

Leave scheduling off if recovery fails. After a successful known-item/search
check, restore the prior schedule if there was one, run a deliberate drain when
its upstreams are safe, and then inspect health. Fresh SQLite has no prior
source-health history, so `NEVER RUN` is expected until that pass.

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

### Create and verify a backup

Wordhold does not choose a backup provider or silently claim that a local Git
repository is a backup. To create recoverable evidence:

1. Run `"$WORDHOLD" drain` when upstreams are available, then record
   `"$WORDHOLD" health` and `git -C "$DATA" rev-parse HEAD`. Note any work that
   remains queued or unhealthy rather than deleting it.
2. Use the owner's backup system to complete a consistent, encrypted off-Mac
   snapshot of the private data root. A whole-root snapshot includes ignored
   in-flight directories. If the backup system cannot snapshot a changing
   directory consistently, run `"$WORDHOLD" unschedule` for the snapshot and
   `"$WORDHOLD" schedule` after it reports completion. Retain the matching
   verified Wordhold archive **and** receipt, or another complete release already
   proven compatible. A receipt alone cannot run a restore.
3. Record the completed snapshot time, canonical commit, included in-flight
   state, known gap, and the backup system's completion/encryption evidence.
4. Restore that snapshot to a new location and run the proof below without
   enabling schedules or upstreams. A job that merely uploaded files, an
   untested archive, and another clone on the same Mac are not restore proof.

Git-only backup excludes ignored `inbox/raw/`, `inbox/merges/`, and `inbox/writer-intents/`. That creates this loss window:

- acknowledged canonical work after the newest backed-up commit can be lost with the Mac;
- unacknowledged Worker/iCloud work may still be upstream and replayable;
- local-only queued work is lost unless the chosen snapshot also includes the ignored inbox;
- `.env`, populated config, Keychain credentials, the personalized phone
  Shortcut, launchd, FDA/Messages permissions, Safari or preserved legacy
  iCloud setup, and Cloudflare resources must be protected or re-created
  separately.

### Prove a restore

To bind a restored private data repository to a verified compiled release,
leave all upstreams and scheduling off until local retrieval succeeds. Point
`DATA` at the restored Git worktree and `RELEASE` at the freshly verified,
unpacked Wordhold artifact. Do not overwrite a recovered real config:

```sh
(
set -eu
DATA=/absolute/path/to/restored-private-data
INSTALL_ROOT=/absolute/path/to/new-program-root
RELEASE=/absolute/path/to/verified-unpacked-wordhold

test -d "$DATA/.git"
test -x "$RELEASE/wordhold"
test ! -e "$INSTALL_ROOT"
git -C "$DATA" fsck --full --strict
SNAPSHOT_COMMIT="$(git -C "$DATA" rev-parse HEAD)"
test -z "$(git -C "$DATA" status --porcelain=v1 --untracked-files=normal)"
for authority_path in .gitignore README.md agent/tags.md \
  logs/new-tags.jsonl logs/resurfacing.jsonl; do
  test -f "$DATA/$authority_path"
  git -C "$DATA" cat-file -e "HEAD:$authority_path"
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
for db_name in papertrail.db papertrail.db-wal papertrail.db-shm; do
  source_file="$DATA/$db_name"
  preserved_file="$source_file.restored-$STAMP"
  if test -e "$source_file"; then
    test ! -e "$preserved_file"
    mv "$source_file" "$preserved_file"
  fi
done

if test ! -e "$DATA/papertrail.config.json"; then
  install -m 600 "$RELEASE/papertrail.config.example.json" \
    "$DATA/papertrail.config.json"
fi
cd "$RELEASE"
./wordhold setup --install-root "$INSTALL_ROOT" --data-root "$DATA"
WORDHOLD="$INSTALL_ROOT/bin/wordhold"
test "$(git -C "$DATA" rev-parse HEAD)" = "$SNAPSHOT_COMMIT"
test -z "$(git -C "$DATA" status --porcelain=v1 --untracked-files=normal)"
"$WORDHOLD" rebuild
"$WORDHOLD" recent
)
```

The shipped example config keeps every optional edge disabled. Compare a known
stable item id and body, then run a known search before recreating private
config, `.env`, Keychain items, Worker bindings, phone Shortcut, permissions,
or schedules. An intentionally empty archive instead needs its recorded empty
item count. `health` may honestly be nonzero because a rebuilt database has no
source history; it is not the offline restore proof. Once external state is
restored deliberately, run a controlled daemon pass and then health before
normal draining. This recovery branch is exercised by the packaged lifecycle
test; off-machine durability still requires the separate evidence below.

Maintainers can run the non-networked same-Mac mechanics proof from a clean
product-source checkout pinned to the installed manifest's exact
`source.revision`, with Bun and dependencies installed:

```sh
(
set -eu
cd /absolute/path/to/wordhold-source
DATA=/absolute/path/to/restored-private-data
PAPERTRAIL_ROOT="$DATA" bun run scripts/verify-local-restore.ts "$DATA"
)
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
- **Unknown sender:** follow [Unknown newsletter senders](#unknown-newsletter-senders). Never authorize from the display `From` header.
- **Sender authorization unavailable:** every verified allow operation has an R2 marker fallback. From that private Worker deployment workspace, run `PAPERTRAIL_ROOT="$DATA" bun run worker:sync-senders` after upgrading an older deployment. If neither D1 nor the marker can establish authorization, the email invocation fails visibly rather than treating a possibly known large sender as unknown and dropping its body.
- **Large email:** body is in R2, not D1. Never “fix” a large-message issue by truncating it; `tests/worker-email.test.ts` is the regression contract.

### Unknown newsletter senders

Inspect `$DATA/logs/quarantine.jsonl`. Verify the SMTP envelope sender, then run
the following from the separate private Worker workspace and drain normally:

```sh
PAPERTRAIL_ROOT="$DATA" bun run worker:allow sender@example.com
```

The RFC `From` header is display metadata, not authorization. Quarantine keeps
the 50 newest D1 rows. Unknown input is read to at most 1 MiB; only a complete
serialized message of at most 32 KiB can be retained inline and released after
approval. Larger quarantined mail stores metadata only, degrades health, and
must be resent after approval. If `legacy_quarantine_requires_resend` appears,
approve the sender and request that resend.

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

### Legacy iCloud recovery

Old local-file Shortcut workflows are withdrawn and must not be used for new
captures. Preserved files are recovery evidence, not an active alternative.
The compatibility adapter can quarantine malformed candidates under
`logs/bad-captures/`; never delete or recycle that evidence merely to make
health green. After accounting for every queued file, disable the legacy edge
with `"$WORDHOLD" iphone legacy-icloud disable`.

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
