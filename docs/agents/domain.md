# Domain documentation

Wordhold is a single-context repository. `README.md` owns the supported product
boundary and documentation map; `docs/architecture.md` owns the implemented
authority, durability, and trust-boundary contracts.

Before engineering exploration, read those two entry documents plus the
accepted decisions under `docs/decisions/` that affect the area being changed.
The current decision index is the directory itself; do not create placeholder
domain documents.

Add a numbered decision under `docs/decisions/` only when a durable architectural
tradeoff cannot be owned clearly by `docs/architecture.md`. Surface conflicts
with an accepted decision instead of silently overriding it, and add any new
decision to the `README.md` documentation map in the same coherent change.
