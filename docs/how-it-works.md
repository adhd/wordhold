# How Wordhold works day to day

Wordhold is a local, asynchronous reading archive. The canonical archive is
Markdown in the private data Git repository; SQLite is a rebuildable search
index. There is no reader website or hosted Wordhold account.

The currently qualified online Shortcut still says **Papertrail**, the
product's name through version 0.4. It saves into the same Wordhold archive.
Its signed bytes and live qualification are retained rather than cosmetically
rewritten. Existing corpus data and the qualified online Shortcut remain
compatible; withdrawn experimental Shortcuts do not become supported again.

## In a nutshell

With the corresponding optional iPhone paths enabled:

```text
iPhone Safari -> Add to Reading List -> Apple iCloud sync -> Mac Safari plist
  -> Wordhold daemon -> fetch/extract -> Markdown -> Git commit -> SQLite

iPhone Safari Share Sheet (one page) -> Save to Papertrail — Online -> Worker durable queue -> Mac daemon
  -> fetch/extract -> Markdown -> Git commit -> SQLite

question in Codex/Hermes -> local Wordhold MCP -> bounded search/get result
```

The phone action and the Wordhold archive are different events. **Add to
Reading List** confirms only that Safari accepted the page. The online
Shortcut's `Accepted by Papertrail: in_…` confirms only that the Worker durably
queued the URL. In both cases, Wordhold archives it only after the daemon
commits it on the Mac.

## Does the Mac need to stay on?

No. The iPhone can add a page while the Mac is off or asleep. Safari/iCloud
holds Reading List state; the Cloudflare Worker holds an accepted online
Shortcut capture. Wordhold cannot archive either until the Mac is awake and
the daemon runs. Reading List must also finish Safari sync. With Wordhold
scheduling and the matching Worker inbox enabled, the daemon runs at login and
normally every five minutes; otherwise run `wordhold drain` manually.

After an ordinary reboot, log into the same macOS account. If scheduling was
enabled, macOS loads the installed Wordhold user LaunchAgent and runs the
daemon at login; no Wordhold app, Terminal command, or Codex session is
required.

Reading List is eventual, best-effort delivery rather than a receipt-bearing
queue; do not delete an important entry before the Mac has observed it. The
online Shortcut is receipt-bearing but has no offline fallback: without phone
internet it does not queue anything or show success.

## Does Codex need to stay running?

No. The compiled Wordhold daemon is a macOS LaunchAgent; it performs capture,
fetching, canonical storage, Git commits, and indexing without the Codex app or
an interactive Codex session.

Codex or Hermes is needed only while using the agent interface: asking a
question, requesting a local capture, or receiving bounded Wordhold evidence.
The optional nightly enrichment job invokes the locally authenticated Codex CLI
itself; the interactive Codex app does not need to remain open. Basic capture,
storage, CLI retrieval, and search do not depend on enrichment.

## How to use it

If the optional Worker is configured and the installed Shortcut has previously
returned a valid receipt, choose **Save to Papertrail — Online** for an ordinary
one-page Safari save. When it shows `Accepted by Papertrail: in_…`, stop: the URL
is durably queued, so do not also add it to Reading List. Choose **Share -> Add
to Reading List** when the phone is offline, the Worker or token is unavailable,
the Shortcut does not return a valid receipt, or the installation does not use
Cloudflare. The Shortcut's generic graph also accepts Text and URL input classes,
but other Share Sheet providers are not live-qualified.

Ask a connected agent, for example:

- `Show my recent Wordhold items.`
- `Search Wordhold for articles about local-first software.`
- `What did I read about HTTP last month?`
- `Save this URL to Wordhold: https://example.com/article`

Or use the installed local CLI:

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" recent
"$WORDHOLD" search 'search terms'
"$WORDHOLD" show ITEM_ID
"$WORDHOLD" health
```

Agent retrieval uses the local stdio MCP interface. It does not expose a public
Wordhold server or upload the corpus wholesale. Selected bounded evidence may
enter the configured agent's model context; see `docs/integrations.md` for that
privacy boundary.

## What can fail independently

- Safari may accept a Reading List entry before iCloud delivers it to the Mac.
- The online Shortcut may fail before a valid `in_…` receipt; in that case the
  Worker has not confirmed a queued capture.
- The Worker may hold an accepted capture while the Mac is off or its daemon is
  temporarily failing.
- Full Disk Access may need to be re-granted if the daemon binary changes.
- Wordhold may preserve a URL and title even when a publisher prevents useful
  body extraction.
- Codex/Hermes connectivity may fail while the local archive and CLI remain
  healthy.

Use `"$WORDHOLD" health` to check the daemon, Worker inbox, and Reading List. See
`docs/operations.md` for troubleshooting and `docs/architecture.md` for the
durability and authority contracts.

## Why there are two iPhone paths

The paths serve different installation and failure states rather than requiring
a daily choice between equals. Reading List is the simplest zero-Cloudflare
path and the fallback when online capture cannot return a receipt. Once the
Worker path is configured and the installed Shortcut has returned one valid
receipt, the online Shortcut is the preferred daily route: its bounded
compatibility qualification covers a durable remote receipt for one Safari page,
while each operator still verifies their own phone and Worker. It requires phone
internet and Cloudflare setup, and other Share Sheet providers are not
live-qualified. It deliberately sends that URL straight to the existing Worker; it has no file,
filename, random identity, caller idempotency key, menu, note/highlight mode, or
iCloud fallback. Repeating a share may create another remote row, while
canonical URL identity makes later local ingestion converge on one item.

The withdrawn 0.3.5–0.3.7 Shortcuts instead attempted a custom iCloud Drive file
handoff. Phone-local Save File completion never proved a reliable correlated
Mac arrival. Those artifacts remain historical evidence and are not alternate
installation choices.
