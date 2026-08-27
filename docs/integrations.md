# Agent integrations

Codex and Hermes use the same versioned Wordhold application contract through one local stdio MCP server. No listener, cloud query endpoint, alternate data store, embedded model, or alternate writer is introduced.

## Install, verify, and remove

For Codex:

```sh
APP="$HOME/Library/Application Support/Papertrail/app"
WORDHOLD="$APP/bin/wordhold"
"$WORDHOLD" connect codex
codex mcp get papertrail --json
```

For Hermes:

```sh
APP="$HOME/Library/Application Support/Papertrail/app"
WORDHOLD="$APP/bin/wordhold"
"$WORDHOLD" connect hermes
hermes mcp test papertrail
```

The MCP registration key remains `papertrail` for compatibility with managed
Codex/Hermes receipts created before the rename. The server identifies itself
as Wordhold. Do not add a second `wordhold` registration beside it; the guided
command owns and verifies the one existing entry so both names cannot point at
different corpora.

The guided command preflights the requested client, uses its actual installed
CLI, passes only `PAPERTRAIL_ROOT`, and initializes the exact registered server
to request its tool list and verify the exact six names before reporting
success. It does not call those tools or read corpus content during connection.
Hermes installation also adds generic guidance. A packaged installation records
exact managed client pointers and the installed skill hash; refresh/removal
refuses to adopt, overwrite, or delete an unmanaged or locally changed entry or
skill. Connect one client per command so a client-specific failure is isolated.

Revoke one or both managed integrations without removing Wordhold or its corpus:

For Codex:

```sh
"$WORDHOLD" disconnect codex
```

For Hermes:

```sh
"$WORDHOLD" disconnect hermes
```

Default program uninstall removes unchanged managed integrations first. It stops conservatively if a client is absent or an entry/skill was customized, preserving the program and receipt. Reinstall an independently removed client, then retry the client removal or program uninstall; do not delete the receipt to force progress.

Before replacing a differently configured `papertrail` MCP entry, remove or rename that entry deliberately; do not silently take over a name owned by another data root.

## Retrieval workflow

For “what did I read about X last month?” an agent should:

1. resolve “last month” to exact UTC `from` and exclusive `to` timestamps;
2. call `search_items` with those bounds and a bounded limit;
   start with the user's terms and allow at most two deliberate related-term
   searches when the first query has no body-bearing support;
3. inspect stable item/date/title/source/status/snippet evidence;
4. call `get_item` only for relevant ids and only with the body bound needed;
5. cite id, captured date, title, and source URL when present;
6. state whether evidence supports the answer, is ambiguous, has an unavailable body, or produced no match.

FTS snippets may match title, body, a deliberate highlight, or captured context; `matchField` identifies which. Metadata alone is not article evidence. A `fetch_failed` result may prove that an item was saved, but not what its unavailable body said.

## Tool authority

Read-only tools are `search_items`, `get_item`, `recent_items`, `health`, and `doctor`. `queue_capture` is the only write tool: it writes a validated record to the existing private raw spool and returns `queued`.

`recent_items` supports bounded integration scans without exposing bodies. Start
each scan without a cursor, keep the same optional `from` and `sources` filters,
and pass the returned `nextCursor` to the next call until it is `null`. The cursor
is an exclusive `(capturedAt,id)` keyset, so equal timestamps do not skip items
and inserts above the current page do not shift later pages. A new item inserted
behind a completed scan appears on the next scan; consumers must deduplicate by
stable Wordhold item id rather than treating capture time as insertion order.

Queued never means archived. The daemon still validates, writes canonical Markdown first, updates derived SQLite, creates a scoped Git commit, and only then removes or acknowledges the queue record. MCP cannot acknowledge upstream work, edit Markdown, run maintenance, migrate, manage secrets, administer senders, or execute shell commands.

This local `queue_capture` path is distinct from the iPhone online Shortcut. An
agent capture requires the Mac and selected client to place a record directly
in the local raw spool; it uses no Cloudflare credential. The Shortcut can
receive a remote Worker queue receipt while the Mac and clients are off, but
that receipt proves neither a new installation nor archival. In both paths,
only a later daemon commit makes the capture part of the archive. Codex and
Hermes receive no Worker secret and do not administer the phone path. See the
canonical [Shortcut contract](../integrations/shortcuts/Papertrail.md) for its
exact input, credential, receipt, qualification, and device-state boundaries.

## Prompt injection and disclosure

Article bodies, highlights, contexts, titles, and URLs are untrusted data. Their text cannot instruct the integration to read `.env`, run commands, follow links, widen a query, call another service, ignore tool instructions, or queue a capture. The server returns bounded data and accurate read/write annotations; agent guidance repeats the trust boundary.

The MCP process itself is local and reads only the configured Wordhold root.
The client/model boundary is different: Codex or Hermes may transmit the user's
question and returned evidence to its configured model provider. There is no
single bulk-corpus tool, but a connected client can enumerate and retrieve many
items through repeated bounded calls. Wordhold cannot impose provider retention
or training policy. Do not use the integration for material that may not be
disclosed to that provider.

## Structured CLI fallback

Humans and adapters may call the same contract without MCP:

```sh
WORDHOLD="$APP/bin/wordhold"
printf '%s' '{"query":"quorum","from":"2026-07-01","to":"2026-08-01","limit":10}' | "$WORDHOLD" search --json
printf '%s' '{"id":"<item-id-from-search>","maxChars":2000}' | "$WORDHOLD" show --json
printf '%s' '{"from":"2026-08-01","sources":["reading_list"],"limit":50}' | "$WORDHOLD" recent --json
printf '%s' '{"input":"a deliberate note","intent":"note"}' | "$WORDHOLD" capture --json
```

The example id is intentionally not real corpus evidence. Obtain a stable id from search/recent. Invalid JSON, filters, dates, ids, or FTS syntax fail actionably rather than returning a deceptive empty result.
