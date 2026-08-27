# How Wordhold works day to day

Wordhold is a local, asynchronous reading archive. Canonical Markdown lives in
one private data Git repository; SQLite is a rebuildable search index. There is
no reader website or hosted Wordhold account.

## The mental model

```text
capture accepted -> queued work -> Mac daemon -> fetch/extract
  -> canonical Markdown -> derived SQLite -> scoped Git commit -> acknowledgement

question in Codex/Hermes -> local Wordhold MCP -> bounded search/get result
```

Queueing and archiving are different events. A local `wordhold capture` receipt
means the request is safely in the Mac's private raw spool. Safari can accept a
Reading List entry without issuing a Wordhold receipt; the optional online
client can instead return a Worker queue receipt. In either case, the item
becomes part of the Wordhold archive only after the daemon commits canonical
Markdown on the Mac.

Markdown and its Git history are the durable authority. SQLite makes that
archive fast to search and can be rebuilt with `wordhold rebuild`. The daemon
writes Markdown first, updates SQLite, commits the scoped change, and only then
acknowledges upstream work. Replays converge on stable items rather than
silently replacing preserved body text, highlights, context, or provenance.

## Capture on the Mac

Capture a note or public reading URL, then let the daemon process it:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" capture 'A note for Wordhold'
"$WORDHOLD" drain
"$WORDHOLD" recent
"$WORDHOLD" health
```

`capture` should return `queued`. If scheduling is installed, the daemon runs
at login and normally every five minutes, so manual `drain` is unnecessary for
ordinary use. Without scheduling, run it deliberately.

## Capture from an iPhone

Wordhold supports two optional Safari paths. They serve different connectivity
and setup needs.

### Safari Reading List

Use Safari's native **Add to Reading List** action for the simplest path or when
the phone is offline. Safari accepts the page, iCloud eventually syncs the list
to Safari on the Mac, and Wordhold imports it after the daemon runs.

Reading List is eventual, best-effort delivery, not a receipt-bearing Wordhold
queue. Do not delete an important entry before the Mac has observed it. This
route requires Safari/iCloud setup on the phone and Mac, Reading List enabled in
Wordhold, and Full Disk Access for the compiled daemon.

### Save to Papertrail — Online

After the optional Cloudflare Worker and phone client are configured, use
**Save to Papertrail — Online** for an ordinary one-page Safari save. The client
retains the earlier Papertrail name but saves into the same Wordhold archive.

Only `Accepted by Papertrail: in_…` means the Worker durably queued the URL. It
does not mean the Mac has fetched, committed, or indexed the page. Once that
receipt appears, stop: do not also add the page to Reading List. If the phone is
offline, the Worker or token is unavailable, or no valid receipt appears, use
Reading List instead.

The online action sends one detectable public URL. It does not preserve notes,
highlights, selected text, or PDF contents, and it has no offline queue. Without
phone internet it queues nothing and cannot show success. Repeating a
successful share may create another Worker row because the phone sends no
caller idempotency key; later local ingestion converges on the canonical URL,
but do not repeat-share merely because the Mac has not drained yet.

See [optional setup](setup.md#4-configure-optional-capabilities) and the
[Shortcut contract](../integrations/shortcuts/Papertrail.md) to configure or
remove this path.

## Does the Mac need to stay on?

No. Safari/iCloud can hold a Reading List entry while the Mac is off or asleep,
and the Cloudflare Worker can hold an accepted online capture. Wordhold cannot
archive either until the Mac wakes and the daemon runs; Reading List must also
finish syncing to Safari on the Mac.

After a reboot, log into the same macOS account. If scheduling is enabled,
macOS loads the Wordhold user LaunchAgent and runs the daemon at login. No
Wordhold app, Terminal window, or Codex session needs to remain open. Automatic
online-Shortcut processing also requires the Worker inbox capability; otherwise
run `wordhold drain` manually.

## Does Codex need to stay running?

No. The compiled daemon performs capture, fetching, canonical storage, Git
commits, and indexing without Codex or Hermes.

An agent client is needed only while asking a question, requesting a local
capture, or receiving bounded Wordhold evidence. The optional enrichment job
invokes the locally authenticated Codex CLI itself; the interactive app does
not need to stay open. Basic capture, storage, CLI retrieval, and search do not
depend on enrichment.

## Read and search the archive

Use the installed CLI:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" recent
"$WORDHOLD" search 'search terms'
"$WORDHOLD" show ITEM_ID
"$WORDHOLD" health
```

Or ask a connected agent:

- `Show my recent Wordhold items.`
- `Search Wordhold for articles about local-first software.`
- `What did I read about HTTP last month?`
- `Save this URL to Wordhold: https://example.com/article`

Agent retrieval uses a local stdio MCP interface, not a public Wordhold server.
There is no single bulk-upload operation, but a connected client can make
repeated bounded calls and may send the question and returned evidence to its
model provider. See [agent integrations](integrations.md) for the exact boundary.

## What can fail independently

- Safari may accept a Reading List entry before iCloud delivers it to the Mac.
- The online Shortcut may fail without a valid `in_…` receipt; the Worker has
  not confirmed a queued capture.
- The Worker may hold an accepted capture while the Mac is off or its daemon is
  failing.
- Full Disk Access may need to be re-granted if the daemon binary changes.
- Wordhold may preserve a URL and title even when a publisher prevents useful
  body extraction.
- Codex or Hermes may be unavailable while the local archive and CLI remain
  healthy.

Use `"$WORDHOLD" health` to distinguish daemon, Worker inbox, Reading List, and
optional-job failures. A queued item is retained work, not garbage; do not
delete it merely to make health green.

Next steps:

- [Install, update, schedule, or add optional capabilities](setup.md)
- [Operate, troubleshoot, back up, recover, or remove Wordhold](operations.md)
- [Understand durability and authority invariants](architecture.md)
