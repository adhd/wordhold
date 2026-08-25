# Save to Papertrail — Online iPhone Shortcut

> **Wordhold compatibility client:** Wordhold was named Papertrail when this
> exact Shortcut was signed and qualified. The title and messages below are
> intentionally unchanged. It writes to the same Wordhold archive; relabeling
> the artifact would invalidate its digest and qualification.

> **0.4.0 status: bounded compatibility qualification.** The offered artifact is
> `Save to Papertrail — Online.shortcut`, 23,567 bytes, with SHA-256
> `ff657efe92c04583586797e633a89a1d66d1287108f4d76b19880288ffde8d95`.
> These exact generic bytes passed one bounded device gate. That evidence does
> not prove a new operator's phone or Worker. Installation-specific endpoint,
> credential, receipt, and corpus evidence remain private.

The artifact is an immutable Apple Anyone-signed export. Its exact bytes are
Git-tracked, recorded in `Papertrail.offer.json`, and hashed again in each
distribution manifest. The shared copy has no Worker URL, token, account name,
private path, or withdrawn build marker. Import personalizes the installed copy
through two questions; that copy is credential-bearing device state.

## Supported use

Safari **Add to Reading List** is the zero-Cloudflare path for a new or
local-only installation. Once the installed online action has returned
one valid `Accepted by Papertrail: in_…` receipt from the installed iPhone
Shortcut, prefer it for ordinary one-page Safari saves. The receipt means the
Worker durably queued the URL; do not also add it to Reading List. Use Reading
List as the fallback when the phone is offline or this action cannot return that
receipt. The installation must already have a deployed Worker, a capture-only
token, and a Mac Worker inbox configured to drain it.

The Shortcut accepts Text, URL, and Safari Web Page input only to extract URLs.
Those input classes are statically verified; the bounded live qualification
covers one Safari page, and other Share Sheet providers are not live-qualified.
It saves one URL. It does not preserve shared prose or selected text, create a
note or highlight, capture PDF contents, choose among multiple URLs, or queue
offline. Zero or multiple extracted URLs write nothing and show:

```text
Papertrail needs exactly one web URL.
```

The export also carries Apple's `WFWorkflowTypeShowInSearch` metadata alongside
its Share Sheet action-extension type. A search launch without input reaches
the same one-URL refusal before networking; it is not a separate capture mode.

## Exact request and receipt graph

The frozen workflow has 16 actions and one path:

1. read the personalized endpoint from the first Text action;
2. read the personalized capture token from the second Text action;
3. extract URLs from explicit Shortcut Input and require the count to equal one;
4. select that first URL;
5. send `POST` to the personalized endpoint with JSON key `url` and header
   `Authorization: Bearer <personalized capture token>`;
6. read response dictionary key `id`;
7. show success only when that value begins with `in_`; otherwise show the
   invalid-receipt alert.

The request body is exactly the equivalent of:

```json
{
  "url": "the one URL extracted from Shortcut Input"
}
```

There is no title, text, timestamp, idempotency key, file action, local queue,
iCloud fallback, menu, random value, date, UUID, or second transport. A native
network/action error stops before success and is not caught or relabeled.

The success notification is:

```text
Accepted by Papertrail: <in_… receipt id>
```

A response without an `id` beginning with `in_` shows:

```text
Papertrail did not return a valid queue receipt.
```

## Install and personalize

First deploy the optional Worker, apply required migrations, configure its
distinct admin and `CAPTURE_SECRET` credentials, enable the Mac's Worker inbox,
and store the capture-only value in macOS Keychain. Then run from an installed
Wordhold 0.5 or later release (the retained Shortcut itself is version 0.4.0):

```sh
WORDHOLD="$HOME/Library/Application Support/Papertrail/app/bin/wordhold"
"$WORDHOLD" iphone setup \
  --base-url https://YOUR_WORKER_ORIGIN \
  --keychain-account YOUR_INSTALLATION_ACCOUNT
```

Pass the HTTPS origin only, without a route path, query, fragment, or embedded
credential. Setup refuses a client whose origin does not exactly match the
Mac's enabled Worker drain.

Setup verifies that the Keychain value reaches capture validation while every
privileged route denies it. It stores only the HTTPS origin and Keychain
reference, not the token. It prints the exact offered artifact path/digest and
the first import answer: the full URL ending in `/v1/save`.

Import that exact `.shortcut` file on the iPhone. Its two questions, in order,
are:

1. `Papertrail Worker save URL?`
2. `Papertrail capture token?`

Neither has a default. For the second answer, run:

```sh
"$WORDHOLD" iphone shortcut copy-token
```

This puts the secret on the Mac clipboard. Paste it through Universal Clipboard,
finish the import, then run:

```sh
"$WORDHOLD" iphone shortcut clear-token
```

The command clears only if the clipboard still exactly equals the current
Keychain token; newer clipboard contents are left alone. The installed Shortcut
and any copy synced by Apple's Shortcuts service now contain that
least-privilege token.

Record acceptance of the offered artifact and inspect Mac-side state with:

```sh
"$WORDHOLD" iphone shortcut approve
"$WORDHOLD" iphone status
```

Approval records the offered generic file and digest; it does not inspect the
personalized phone workflow or prove a run. Status keeps
`approval_required`/`approved`/`update_available`/`repair_required`,
capture-only verification, and `liveDevice: unknown` separate.
`repair_required` means the active artifact no longer matches its stored offer;
rerun setup, re-import/update the exact offered artifact, and approve it.
`state: blocked` with `worker: drain_unconfigured` means the resolved local
Worker capability, origin, or admin-secret reference does not match this online
client; restore the matching drain before repeating setup. Its `legacyIcloud`
member describes only preserved historical local-file state.

## Durability boundary

The Worker validates the capture-only credential and public URL, inserts a D1
row, and only then returns its minimal `{id: "in_…"}` response. Therefore
`Accepted by Papertrail: in_…` is a durable remote queue receipt. It is not a
claim that the page was fetched, extracted, written to Markdown, committed, or
retrievable.

The Mac and Codex may be off when the receipt appears. A later daemon pass pulls
the row with the admin credential, persists the raw capture, writes canonical
Markdown and derived SQLite, creates a scoped `daemon:` Git commit, then
acknowledges the Worker. Automatic processing requires the Worker inbox
capability plus installed scheduling; otherwise run `wordhold drain`. Confirm
the commit and structured retrieval before calling the item archived.

Because this Shortcut sends no caller idempotency key, repeating a successful
share may create another Worker row and receipt. Canonical URL identity makes
later ingestion converge on one item, but users should not repeat a gesture
merely because the Mac has not drained yet.

## Rotation, removal, update, and maintenance

Keychain is the Mac's verification and clipboard source, not a live link to the
phone. To rotate the token, replace `CAPTURE_SECRET` in Cloudflare and Keychain,
rerun `iphone setup`, then replace the installed token Text value or re-import
the exact artifact and answer both questions again. Setup invalidates the prior
approval even when its reference names and generic bytes are unchanged; clear
the clipboard and run `iphone shortcut approve` only after the phone has the
new answers. Never place the admin `SECRET` on the phone.

`iphone disable` removes only the Mac's online-client reference. It does not
delete the phone Shortcut, clear its token, remove the Keychain item, revoke the
Worker credential, delete remote rows, or alter the corpus. Remove or revoke
each external piece deliberately.

Program update can refresh the offered generic artifact digest but cannot edit
the phone. If the digest changes, existing approval remains attached to the old
bytes and status becomes `update_available`; re-import and approve the new exact
artifact. Endpoint/token personalization alone does not change the generic
graph. Any semantic editor change does: it requires a new candidate digest,
affected static/package tests, and the bounded live gate again.

The editable master lives in Apple's Shortcuts library; the Git-tracked file is
the immutable Apple export. Do not decode, patch, generate, or re-sign a
replacement and present it as the reviewed artifact.

## Historical withdrawn attempts

The following local-file workflows remain only in Git/release and private
operator history. Their adapter compatibility is recovery support, not an
active installation choice.

- **0.3.5:** the generated three-mode graph passed static/package checks but its
  live Link path produced an empty URL, and a final Output action triggered a
  Shortcuts conversion error. Its Note and Highlight branches were never
  qualified.
- **0.3.6:** the Apple-authored Link graph extracted the canonical Safari URL and
  wrote a valid Dictionary body, but iOS inferred a `.txt` extension and clamped
  its oversized random bound. The observed filename
  `papertrail-link-0.3.6-2147483647.txt` can collide, so it must not be run.
- **0.3.7:** the revised local-file graph used an intentional `.txt` envelope and
  two safe nine-digit values. A live phone run reported
  `Queued for Papertrail validation.`, but no correlated file, marker, identity,
  commit, or retrieval appeared in the caught-up Mac iCloud container. That
  phone-local notification was not a Papertrail receipt.

Do not import, run, or resurrect any of those workflows. Preserve legacy queue
and rejected-file evidence byte-exactly when recovery is required.
