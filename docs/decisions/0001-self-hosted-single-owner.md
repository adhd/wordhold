# ADR 0001: public-source, local-first, single-owner macOS

Status: accepted

Wordhold is publicly distributed under Apache-2.0 as sanitized source plus an
experimental compiled release for technical Apple-Silicon Mac users. Each
installation has one private data root and one canonical Git authority
controlled by its owner. Local stdio MCP is the agent boundary. Optional
Cloudflare/device/model/message components are owner-configured edges, not a
hosted Wordhold service.

This is the smallest shape that preserves the existing authority,
commit-before-acknowledgement, privacy, and recovery model while allowing anyone
to install an independent instance. It avoids making a private corpus repository
public or treating one account/device observation as a product default.

A hosted or multi-user product would additionally require an account and tenancy model, authorization across users/devices/agents, encrypted remote corpus storage and key lifecycle, deletion/export/retention policy, abuse and rate controls, remote query isolation, audited administration, availability/backups/disaster recovery, privacy/legal terms, billing/cost limits, operations/on-call, and a migration from local Git authority. A public HTTP MCP endpoint would inherit those requirements.

Those are not incremental packaging details and are deferred. Linux/Windows and
Intel Mac support, Developer ID signing/notarization, package-manager
distribution, and broader product-name clearance are also separate decisions.
The public compiled RC is therefore described exactly as Apple-Silicon-only,
ad-hoc signed, and unnotarized; publication does not imply seamless Gatekeeper
behavior, broad compatibility, or a support guarantee.
