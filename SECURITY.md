# Security policy

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** flow for this repository.
Do not open a public issue with exploit details, credentials, corpus content,
configuration files, logs, machine paths, or other private installation data.

Send the smallest reproduction that establishes the problem. Redact tokens,
item text, URLs that are not already public, usernames, hostnames, and local
paths. If a provider token may have been disclosed, revoke and replace it
immediately rather than waiting for a response.

If private vulnerability reporting is unavailable, open a public issue that
only says the private reporting channel is unavailable. Do not attach the
vulnerability or private artifacts.

Reports are handled on a best-effort basis with no response-time guarantee.
The supported security boundary is the current public release candidate and
the current `main` branch; optional services and integrations remain subject
to their own providers' security and retention policies.

## Installation data

The product source repository must never contain an installation's private
corpus, credentials, configuration, logs, Keychain exports, or generated
operator evidence. Each installation keeps that material outside this source
repository. See [Architecture](docs/architecture.md) for the trust boundaries
and [Operations](docs/operations.md) for credential rotation and recovery.
