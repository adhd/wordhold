import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const genericDocs = [
  "README.md",
  "AGENTS.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/how-it-works.md",
  "docs/setup.md",
  "docs/operations.md",
  "docs/integrations.md",
  "docs/release-verification.md",
  "docs/source-provenance.md",
  "docs/decisions/0001-self-hosted-single-owner.md",
  "integrations/shortcuts/Papertrail.md",
  "integrations/hermes/papertrail/SKILL.md",
];

test("public cold-start documentation has valid links and preserves private-data boundaries", () => {
  const combined: string[] = [];
  const byPath = new Map<string, string>();
  for (const relativePath of genericDocs) {
    const absolute = join(root, relativePath);
    const text = readFileSync(absolute, "utf8");
    byPath.set(relativePath, text);
    combined.push(text);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1]!.replace(/^<|>$/g, "").split("#")[0]!;
      if (!rawTarget || /^(?:https?:|mailto:)/.test(rawTarget)) continue;
      const target = resolve(dirname(absolute), rawTarget);
      expect(existsSync(target), `${relativePath} -> ${rawTarget}`).toBe(true);
    }
  }
  const text = combined.join("\n");
  expect(text).not.toMatch(/\/Users\/|com\.[a-z0-9_-]+\.papertrail\b/i);
  expect(text).not.toContain("docs/verification.md");
  expect(text).toContain("public-source, local-first, single-owner macOS");
  expect(text).not.toMatch(/\binvited\b/i);
  expect(text).not.toContain("David");
  expect(byPath.get("SECURITY.md")).toContain("Report a vulnerability");
  expect(byPath.get("SECURITY.md")).toContain(
    "Do not open a public issue with exploit details",
  );
  expect(byPath.get("SECURITY.md")).toMatch(
    /revoke and replace it\s+immediately/,
  );
  expect(text).toContain("queued");
  expect(/body[- ]unavailable|unavailable body/.test(text)).toBe(true);
  expect(text).toContain("model provider");
  expect(byPath.get("README.md")).toMatch(/preferred\s+daily path/);
  expect(byPath.get("README.md")).toMatch(
    /it is\s+not checked into this source repository\s+as\s+a\s+compiled\s+binary/,
  );
  expect(byPath.get("README.md")).toContain("./wordhold update");
  expect(byPath.get("README.md")).toContain(
    "Wordhold-0.5.0-rc.3-darwin-arm64.tar.gz",
  );
  expect(byPath.get("README.md")).toContain("Source code (tar.gz)");
  expect(byPath.get("README.md")).toContain("macOS 13 as their deployment floor");
  expect(byPath.get("README.md")).toContain("Apple-Silicon macOS 14");
  expect(byPath.get("README.md")).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(byPath.get("README.md")).toContain("bun run verify:licenses");
  expect(byPath.get("README.md")).toContain("af24e281ebacd6ac77c0f14b4206599cf4ae1c9f");
  expect(byPath.get("README.md")).toContain(
    'BUN_EXECUTABLE="$(command -v bun)"',
  );
  expect(byPath.get("README.md")).toContain(
    'shasum -a 256 "$BUN_EXECUTABLE"',
  );
  expect(byPath.get("README.md")).toContain(
    "1d77af7bfd811aebb7d37bec496a5eed14fe227ded3ab7866d2f39786e8107b6",
  );
  expect(byPath.get("docs/how-it-works.md")).toContain(
    "do not also add it to",
  );
  expect(byPath.get("docs/setup.md")).toContain("./wordhold setup");
  expect(byPath.get("docs/setup.md")).toContain("./wordhold update");
  expect(byPath.get("docs/setup.md")).toContain("set -eu");
  expect(byPath.get("docs/setup.md")).toContain(
    `printf '{}\\n' | "$WORDHOLD" recent --json`,
  );
  expect(byPath.get("docs/setup.md")).toContain(
    '"$WORDHOLD" show ITEM_ID_FROM_RECENT',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    'xattr -dr com.apple.quarantine "$RELEASE"',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    'codesign --verify --strict "$RELEASE/wordhold"',
  );
  expect(byPath.get("docs/setup.md")).toContain("/usr/bin/sw_vers");
  expect(byPath.get("docs/setup.md")).toContain("/usr/bin/otool");
  expect(byPath.get("docs/setup.md")).toContain("/usr/bin/lipo");
  expect(byPath.get("docs/setup.md")).not.toContain("spctl --master-disable");
  expect(byPath.get("docs/setup.md")).toContain('"$WORDHOLD" connect codex');
  expect(byPath.get("docs/setup.md")).toMatch(
    /Configure enrichment, digest, and resurfacing\s+before this command/,
  );
  expect(byPath.get("docs/setup.md")).toContain(
    'rerun `"$WORDHOLD" schedule` to reconcile the owned jobs',
  );
  expect(byPath.get("docs/setup.md")).toContain('"$WORDHOLD" iphone setup');
  expect(byPath.get("docs/setup.md")).toContain("Save to Papertrail —");
  expect(byPath.get("docs/setup.md")).toContain("Online.shortcut");
  expect(byPath.get("docs/setup.md")).toContain(
    '"$WORDHOLD" iphone shortcut copy-token',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    '"$WORDHOLD" iphone shortcut clear-token',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    '"$WORDHOLD" iphone shortcut approve',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    "The failed local-file 0.3.5, 0.3.6, and 0.3.7 workflows were not imported",
  );
  expect(byPath.get("docs/setup.md")).not.toContain(
    "remain withdrawn in Git history",
  );
  expect(byPath.get("docs/setup.md")).not.toContain("qualification-only");
  expect(byPath.get("docs/setup.md")).not.toContain("iphone worker setup");
  expect(byPath.get("docs/setup.md")).not.toContain("Build the generic workflow");
  expect(byPath.get("docs/setup.md")).not.toMatch(/bun run (?:lifecycle|install:agents)/);
  expect(byPath.get("docs/setup.md")).toContain(
    "Wordhold-$RC-darwin-arm64.receipt.json",
  );
  expect(byPath.get("docs/setup.md")).toContain("shasum -a 256 -c -");
  expect(byPath.get("docs/setup.md")).toContain(
    'INSTALL_ROOT="$HOME/Library/Application Support/Papertrail/app"',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    'WORDHOLD="$INSTALL_ROOT/bin/wordhold"',
  );
  expect(byPath.get("docs/setup.md")).toContain(
    "~/Library/Safari/Bookmarks.plist",
  );
  expect(byPath.get("docs/setup.md")).toContain("wrangler d1 create");
  expect(byPath.get("docs/setup.md")).toContain("wrangler r2 bucket create");
  expect(byPath.get("docs/setup.md")).toContain("wrangler secret put SECRET");
  expect(byPath.get("docs/setup.md")).toContain("wrangler secret put CAPTURE_SECRET");
  expect(byPath.get("docs/setup.md")).toContain("env:PAPERTRAIL_SECRET");
  expect(byPath.get("docs/integrations.md")).toContain(
    'WORDHOLD="$APP/bin/wordhold"',
  );
  expect(byPath.get("docs/integrations.md")).toContain('"$WORDHOLD" disconnect hermes');
  expect(byPath.get("docs/operations.md")).toContain("./wordhold update");
  expect(byPath.get("docs/operations.md")).toContain(
    "./wordhold update --install-root /absolute/custom/program/root",
  );
  expect(byPath.get("docs/operations.md")).toContain("package:distribution");
  expect(byPath.get("docs/operations.md")).toContain('"$WORDHOLD" drain');
  expect(byPath.get("docs/operations.md")).toContain(
    '"$WORDHOLD" iphone status',
  );
  expect(byPath.get("docs/operations.md")).toContain(
    '"$WORDHOLD" iphone disable',
  );
  expect(byPath.get("docs/operations.md")).toContain(
    '"$WORDHOLD" iphone shortcut clear-token',
  );
  expect(byPath.get("docs/operations.md")).toContain('WORDHOLD="$APP/bin/wordhold"');
  expect(byPath.get("docs/operations.md")).not.toContain('"$PT"');
  expect(byPath.get("docs/operations.md")).toContain(
    "--config worker/wrangler.toml",
  );
  expect(byPath.get("docs/how-it-works.md")).not.toContain("bun run pt");
  expect(text).toContain("retains the Papertrail machine namespace");
  expect(byPath.get("docs/operations.md")).toContain("complete archive SHA-256");
  expect(byPath.get("docs/operations.md")).toContain(
    "scripts/release-candidate.ts",
  );
  expect(byPath.get("docs/operations.md")).toContain(
    "bun --no-env-file --config=/dev/null run scripts/release-candidate.ts",
  );
  expect(byPath.get("docs/release-verification.md")).toContain(
    "bun --no-env-file --config=/dev/null run scripts/release-candidate.ts",
  );
  expect(byPath.get("docs/release-verification.md")).toContain(
    "lifecycleValidationCommands",
  );
  expect(text).not.toContain("--config /dev/null");
  expect(byPath.get("docs/operations.md")).toContain(
    "ambient `node_modules` is not release input",
  );
  expect(byPath.get("docs/operations.md")).toContain("release:verify-download");
  expect(byPath.get("docs/operations.md")).toContain("env -u GH_TOKEN -u GITHUB_TOKEN curl");
  expect(byPath.get("docs/operations.md")).toContain("isImmutable");
  expect(byPath.get("docs/operations.md")).toMatch(/\(\nset -eu\nREPOSITORY=/);
  expect(byPath.get("docs/operations.md")).toContain(
    'install -m 600 "$RELEASE/papertrail.config.example.json"',
  );
  expect(byPath.get("docs/operations.md")).toContain(
    './wordhold setup --install-root "$INSTALL_ROOT" --data-root "$DATA"',
  );
  expect(text).not.toContain("1444f47");
  expect(byPath.get("docs/release-verification.md")).toContain(
    "PUBLIC RC QUALIFIED",
  );
  expect(byPath.get("docs/release-verification.md")).toContain(
    "requires `adhd/wordhold` to be public",
  );
  expect(byPath.get("docs/release-verification.md")).not.toContain(
    "READY FOR RECIPIENT VALIDATION",
  );
  expect(byPath.get("docs/source-provenance.md")).toContain(
    "https://github.com/adhd/wordhold.git",
  );
  expect(byPath.get("docs/source-provenance.md")).toContain("legacy graft files");
  expect(byPath.get("docs/source-provenance.md")).toContain(
    "history-free, audited snapshot",
  );
  expect(byPath.get("docs/source-provenance.md")).not.toContain(
    "retained pre-policy documentation blobs",
  );
  expect(text).not.toContain("prior-version fixture migration");
  expect(byPath.get("integrations/shortcuts/Papertrail.md")).toContain(
    "immutable Apple export",
  );
  expect(byPath.get("integrations/shortcuts/Papertrail.md")).toContain(
    "bounded live qualification",
  );
  expect(byPath.get("integrations/shortcuts/Papertrail.md")).toMatch(
    /Use Reading\s+List as the fallback/,
  );
  expect(text).toContain("other Share Sheet providers are not live-qualified");
  expect(byPath.get("docs/operations.md")).toContain("`repair_required` means");
  expect(byPath.get("docs/operations.md")).toContain("drain_unconfigured");
  expect(byPath.get("integrations/shortcuts/Papertrail.md")).toContain(
    "The frozen workflow has 16 actions and one path",
  );
  expect(byPath.get("integrations/shortcuts/Papertrail.md")).toContain(
    "Historical withdrawn attempts",
  );
  expect(byPath.get("docs/architecture.md")).toContain("`iphoneOnline` state");
  expect(byPath.get("docs/architecture.md")).toContain(
    "clears inherited `GIT_*` state",
  );
  expect(byPath.get("docs/release-verification.md")).toContain(
    "0.4.0 Save to Papertrail — Online — bounded compatibility qualification",
  );
});
