# Release verification

This file owns the durable, generic release gate. Candidate-specific revisions,
release ids, asset facts, command results, and reviewer dispositions belong in
sanitized GitHub release notes/metadata or a maintainer ledger. User/device
details, permissions, endpoints, and account resource names belong only in
private operator evidence. Historical test totals are not evidence for a new
candidate and are intentionally not repeated here.

## v0.5 release-candidate gate

Finish code, tests, and documentation before selecting an RC. The candidate
source must be a clean committed `0.5.0` checkout on Apple Silicon, with local
`HEAD`, `origin/main`, the pushed `v0.5.0-rc.N` tag, and the later artifact
manifest all resolving to the same revision. Before the tag is pushed, run the
full suite, application and Worker typechecks, standalone compilation,
source/history/privacy checks, documentation checks, lifecycle and compatibility
tests, and focused tests for any changed path.

`bun --no-env-file --config /dev/null run scripts/release-candidate.ts
--candidate v0.5.0-rc.N --output NEW_DIRECTORY` is the release producer. The
explicit flags prevent ignored cwd dotenv and Bun configuration from becoming
producer input. It fails unless the tag resolves to `HEAD`, package and
candidate versions agree, the source boundary passes, the output path is new,
every distributed source byte equals its committed `HEAD` blob, and the built
manifest is clean `darwin/arm64` from that revision. It rejects an unpinned Bun
compiler, shallow or
legacy-grafted source history and installs locked production dependencies
inside the new build root with package scripts disabled rather than consuming
ambient `node_modules`. It
produces exactly one compiled artifact directory, one `.tar.gz`, and one
path-free `.receipt.json`. The receipt binds candidate, product version, source
revision, internal release id, thin arm64 target, macOS deployment floor, Bun
version/revision/compiler digest, artifact root, archive name, byte size, and
SHA-256. Every compiled executable must carry the recorded deployment floor and
runtime `.env`/`bunfig.toml` autoload must be disabled.

The lower-level `build:distribution` and `package:distribution` commands remain
development primitives. Their output is not a release candidate unless it has
gone through the RC producer and the remote qualification below.

## Immutable remote qualification

Enable repository release immutability before creating the release. Create a
draft prerelease for the already-pushed RC tag and upload only the named compiled
archive and receipt. Do not upload a corpus, runtime state, credentials, operator
evidence, or GitHub's automatic source archives as install assets.

Qualify the remote bytes in this order:

1. Download the two draft assets into a fresh empty directory.
2. Compare both downloads byte-for-byte with the producer outputs.
3. Run `release:verify-download` against those downloaded paths and the exact
   retained v0.1 input below.
4. Publish only after that passes. Publication must report the expected tag,
   prerelease state, immutable state, and exactly the two expected assets.
5. Download the published assets into another fresh empty directory, compare
   them again, and rerun `release:verify-download`.

Drafts are mutable; published immutable releases are not. Never use `--clobber`,
move a published RC tag, or replace/delete a published asset. Do not silently
swap candidate bytes while a release is still a draft. If code, documentation
inside the artifact, archive bytes, or receipt bytes change, use a new RC
identifier and repeat the complete gate.

`release:verify-download` fails closed unless its download directory contains
only the archive and receipt. It verifies their exact names, regular-file types,
size and SHA-256. With explicit `--release-state draft` or `published`, it also
queries authenticated GitHub metadata, requires `adhd/wordhold` to be public,
binds source `HEAD`, `origin/main`, remote `main`, the remote candidate tag, and
the receipt revision, and checks the expected draft or published immutable
prerelease state plus exactly two remote asset sizes and SHA-256 digests. It
snapshots all inputs before use, rejects unsafe tar members and non-neutral
ownership metadata, extracts under a path containing spaces, verifies the
manifest format, inventory, clean source identity, actual thin Mach-O target,
deployment floor, pinned toolchain, disabled runtime autoload, internal release
id, and every executable's strict ad-hoc signature, then runs the guided
lifecycle and retained-v0.1 upgrade tests with every shipped executable taken
from that downloaded extraction. The source checkout supplies the test harness,
not a substitute product build.

## Exact retained v0.1 upgrade input

The compatibility authority is a privately retained v0.1 arm64 release
archive, 134,732,335 bytes, with SHA-256
`d4e24a228a67de6b3494ce9c2f3bb056528f51952f7022b0b36c381c7be590f1`.
Its local filename is not public identity.
Do not substitute a rebuild, modified copy, or synthetic prior-version fixture.
A digest mismatch blocks the upgrade claim.

`tests/v01-upgrade.test.ts` is deliberately skipped when
`PAPERTRAIL_V01_ARCHIVE` is absent, so an ordinary green `bun test` does not
prove this gate. `release:verify-download` requires both the explicit archive
path and the pinned digest and supplies the downloaded candidate through
`WORDHOLD_RELEASE_ARTIFACT`. The proof creates its baseline only through the
retained artifact's packaged capture and daemon commands; current source does
not pre-migrate or rewrite it. It must preserve the seeded canonical note and
manual highlight, stable ids, capture context, config bytes, private Git
history, rollback after a staged failure, and data after uninstall.

## Wordhold naming and machine compatibility

Version 0.5 changes the human-facing product name and preferred command to
`wordhold`. It deliberately retains the Papertrail machine namespace: corpus,
config/database paths, stable ids, install receipt authority, LaunchAgent labels,
Full Disk Access target, MCP registration key, Keychain service, Worker
resources, frozen phone client, and `papertrail`/`pt` aliases. A compatible
upgrade updates the existing installation in place; it does not create a second
data root, job, integration, or remote resource.

The packaged lifecycle gate covers clean setup, capture, daemon commit,
retrieval, database deletion/rebuild, idempotent setup/update, staged-update
rollback, data-preserving uninstall/reinstall, custom roots, command aliases,
and isolated Codex/Hermes registration. Synthetic and packaged evidence never
counts as a live account, device, provider, or other installation observation.

## 0.4.0 Save to Papertrail — Online — bounded compatibility qualification

The retained compatibility client is the immutable Apple-signed
`Save to Papertrail — Online.shortcut`, SHA-256
`ff657efe92c04583586797e633a89a1d66d1287108f4d76b19880288ffde8d95`.
Its bounded contract accepts Text, URL, or Safari Web Page input only to extract
exactly one public URL, sends that URL to a separately personalized capture-only
Worker endpoint, and treats only an `in_…` receipt as remote queue success.
Queued is not archived; a later daemon commit and retrieval prove archival.

The client does not capture selected text or PDF contents, create notes or
highlights, choose among multiple URLs, provide an offline fallback, or prove
other Share Sheet providers are live-qualified. Its bounded evidence does not
establish that a new operator's phone, Worker, or installation works. Changing
its signed bytes or behavior requires its own new digest and evidence; branding
work must not fork the retained machine contract.

## Evidence states for a public RC

- **Candidate qualified locally:** the clean tagged producer output passed the
  source and local artifact gates. No remote or public-download claim follows.
- **PUBLIC RC QUALIFIED:** the public prerelease is published and immutable, and
  a final fresh unauthenticated public asset download passed exact remote
  identity, downloaded-artifact qualification, clean setup, retained-v0.1
  update, and the local core lifecycle. Maintainer qualification may still use
  authenticated GitHub metadata; the downloaded product bytes must not require
  repository credentials. The RC may be published with this evidence.

Public HTTPS download proves the public remote round trip, not browser quarantine or
Gatekeeper behavior. A maintainer may record one real browser download and
Gatekeeper observation using the shipped setup guidance, but browser proof does
not block publishing public source or an explicitly experimental ad-hoc RC. Do
not synthesize an extended attribute or generalize one observed Mac to broad
compatibility.

If the RC is later promoted, final `v0.5.0` must target the same revision and
upload the archive and receipt from the final verified published-RC download
under their existing names. Do not rebuild, repackage, edit, or rename them.
Different bytes require a new immutable RC and the complete gate again.

None of these states claims Developer ID signing, notarization, publisher
identity, broad macOS support, live optional integrations, independently tested
iPhone capture, or off-machine restore. Ad-hoc signatures detect malformed
executables but do not identify the publisher. Keep personal execution evidence
outside the distributable source and release assets.
