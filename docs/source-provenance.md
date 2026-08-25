# Source provenance

This public repository began as a deliberately history-free, audited snapshot
of the Wordhold product tree. The predecessor combined product development with
private release provenance, so none of its Git objects, branches, tags,
remotes, ignored state, author history, or release assets were imported.

The snapshot used a positive inventory: root product and licensing metadata;
generic agent, CLI, core, daemon, MCP, integration, script, test, and type
sources; generic architecture/setup/operations/integration/release documents;
public CI; and Worker source, migrations, type configuration, and the
placeholder Wrangler template.

It excluded corpus items and journals, the private tag vocabulary, populated
configuration and deployment identifiers, operator verification, databases,
queues, logs, credentials, build/dependency output, archives, and every prior
Git directory. Before the first public commit, the complete selected tree and
the release artifact were checked for personal paths, credentials, private
deployment identifiers, forbidden private paths, and unexpected files.

Wordhold was called Papertrail through version 0.4. The public snapshot retains
the machine-facing Papertrail namespace only where changing it could fork an
existing installation or invalidate a qualified compatibility artifact.

This repository is the canonical public Wordhold product-code authority. Every
installation creates a different private Git repository for its corpus; those
data repositories are never product source and must never be published.

Its sole canonical remote is the credential-free fetch and push URL
`https://github.com/adhd/wordhold.git`, named `origin`. The reviewed ref boundary
allows only local `main`, `origin/main`, the optional `origin/HEAD` tracking
ref, and release tags of the form `vX.Y.Z` or `vX.Y.Z-rc.N`. Extra branches,
tags, notes, remotes, replacement refs, push URLs, or differently named origins
are not part of the publishable authority.

Source verification scans the current tree and every reachable historical
blob. It rejects shallow repositories, legacy graft files, replacement refs,
object alternates, private runtime paths, personal home paths, credentials,
private keys, and populated provider hosts and database identifiers. The
one-time cutover also supplied the private predecessor revision as an explicit
forbidden object and proved it was absent; that private identity is not
hard-coded into the public verifier. Passing these bounded detectors
supplements rather than replaces the positive source and artifact inventories.

`integrations/shortcuts/Save to Papertrail — Online.shortcut` is the exact
Anyone-signed Apple Shortcuts export retained as the 0.4 compatibility client.
Its release identity is SHA-256
`ff657efe92c04583586797e633a89a1d66d1287108f4d76b19880288ffde8d95`.
The shared export contains empty endpoint and token fields with native import
questions; personalized answers and live deployment evidence remain outside
this repository. Release building decrypts and checks the workflow contract
before packaging instead of treating the encrypted envelope as inspectable
plain text. Its Papertrail name and messages are historical facts and active
compatibility behavior, not current product branding; changing them requires a
separately signed and qualified Shortcut release.
