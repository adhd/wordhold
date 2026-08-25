# Bun 1.3.11 source and relinking

Wordhold's compiled macOS executables embed the runtime from the compiler that
reports Bun `1.3.11`, revision
`af24e281ebacd6ac77c0f14b4206599cf4ae1c9f`. The exact upstream source is:

<https://github.com/oven-sh/bun/tree/af24e281ebacd6ac77c0f14b4206599cf4ae1c9f>

Public release production additionally pins the official Apple-Silicon
compiler executable to SHA-256
`1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6`.
The artifact manifest and release receipt record that compiler digest.

The adjacent `LICENSE.md` reproduces the `LICENSE.md` content at that exact
commit, with only a terminating newline added at EOF. It documents Bun's
MIT-licensed code, statically linked LGPL components, other linked libraries,
and the upstream JavaScriptCore/Bun rebuild path. Follow that file and Bun's
build instructions to build Bun with a modified linked library.

To rebuild Wordhold with that Bun, check out the Wordhold source revision named
by the release manifest, install its locked dependencies, and run its
distribution builder with the resulting Bun executable:

```sh
/path/to/modified/bun install --frozen-lockfile --ignore-scripts
/path/to/modified/bun run scripts/build-distribution.ts --output /new/output/path
```

The distribution builder invokes its own `process.execPath` for dependency
installation and every `bun build --compile` step, so those commands embed
the selected modified runtime rather than another ambient Bun installation.
