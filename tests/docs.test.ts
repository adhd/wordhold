import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const root = join(import.meta.dir, "..");
const skippedDirectories = new Set([
  ".git",
  ".scratch",
  ".wrangler",
  "build",
  "dist",
  "inbox",
  "items",
  "licenses",
  "logs",
  "node_modules",
]);
const skippedFiles = new Set(["THIRD_PARTY_NOTICES.md", "agent/tags.md"]);

function maintainedMarkdown(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...maintainedMarkdown(absolute));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      const repoPath = relative(root, absolute).split(sep).join("/");
      if (!skippedFiles.has(repoPath)) paths.push(repoPath);
    }
  }
  return paths.sort();
}

const docPaths = maintainedMarkdown(root);
const docs = new Map(
  docPaths.map((path) => [path, readFileSync(join(root, path), "utf8")]),
);

function headingSlug(rawHeading: string): string {
  return rawHeading
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function withoutFencedCode(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (!fence && marker) {
        fence = marker;
        return "";
      }
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
          fence = undefined;
        }
        return "";
      }
      return line;
    })
    .join("\n");
}

function markdownAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  const prose = withoutFencedCode(markdown);
  for (const match of prose.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = headingSlug(match[1]!);
    const seen = occurrences.get(base) ?? 0;
    occurrences.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  for (const match of prose.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/gi)) {
    anchors.add(match[1]!);
  }
  return anchors;
}

function linkDestination(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.split(/\s+/, 1)[0]!;
}

function shellBlocks(markdown: string): string[] {
  return Array.from(
    markdown.matchAll(/```sh\n([\s\S]*?)```/g),
    (match) => match[1]!,
  );
}

const inheritedShellVariables = [
  "HOME",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "TMPDIR",
  "USER",
];

function undefinedShellVariables(markdown: string): string[] {
  const defined = new Set(inheritedShellVariables);
  const undefinedUses: string[] = [];
  for (const block of markdown.matchAll(/```sh\n([\s\S]*?)```/g)) {
    for (const rawLine of block[1]!.split("\n")) {
      const line = rawLine.replace(/#.*$/, "");
      for (const use of line.matchAll(/\$(?:\{)?([A-Z][A-Z0-9_]*)/g)) {
        const name = use[1]!;
        if (!defined.has(name)) undefinedUses.push(`${name}: ${rawLine.trim()}`);
      }
      const assignment = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/);
      if (assignment) defined.add(assignment[1]!);
    }
  }
  return undefinedUses;
}

function sectionAtAnchor(markdown: string, anchor: string): string {
  const lines = markdown.split("\n");
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]!.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading && headingSlug(heading[2]!) === anchor) {
      start = index;
      level = heading[1]!.length;
      break;
    }
  }
  if (start === -1) throw new Error(`missing heading anchor: ${anchor}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index]!.match(/^(#{1,6})\s+/);
    if (heading && heading[1]!.length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

test("maintained documentation inventory includes every owned Markdown surface", () => {
  for (const expected of [
    "README.md",
    "AGENTS.md",
    "SECURITY.md",
    "agent/prompts/enrich.md",
    "docs/agents/domain.md",
    "docs/how-it-works.md",
    "docs/setup.md",
    "docs/operations.md",
    "docs/release-verification.md",
    "integrations/hermes/papertrail/SKILL.md",
    "integrations/shortcuts/Papertrail.md",
  ]) {
    expect(docPaths, expected).toContain(expected);
  }
  expect(docPaths).not.toContain("THIRD_PARTY_NOTICES.md");
  expect(docPaths.some((path) => path.startsWith("licenses/"))).toBe(false);
  expect(docPaths.some((path) => path.startsWith(".scratch/"))).toBe(false);
  expect(docPaths).not.toContain("agent/tags.md");
});

test("all local Markdown links resolve to real files and headings", () => {
  for (const [repoPath, markdown] of docs) {
    const source = join(root, repoPath);
    const prose = withoutFencedCode(markdown);
    const destinations = [
      ...Array.from(prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g), (match) => match[1]!),
      ...Array.from(
        prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm),
        (match) => match[1]!,
      ),
      ...Array.from(
        prose.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi),
        (match) => match[1]!,
      ),
    ];
    for (const rawDestination of destinations) {
      const destination = linkDestination(rawDestination);
      if (!destination || /^[a-z][a-z0-9+.-]*:/i.test(destination)) continue;

      const hashAt = destination.indexOf("#");
      const rawFile = hashAt === -1 ? destination : destination.slice(0, hashAt);
      const rawAnchor = hashAt === -1 ? "" : destination.slice(hashAt + 1);
      const target = rawFile
        ? resolve(dirname(source), decodeURIComponent(rawFile))
        : source;

      expect(existsSync(target), `${repoPath} -> ${destination}`).toBe(true);
      if (rawAnchor && extname(target).toLowerCase() === ".md") {
        const anchor = decodeURIComponent(rawAnchor).toLowerCase();
        const targetMarkdown = readFileSync(target, "utf8");
        expect(
          markdownAnchors(targetMarkdown).has(anchor),
          `${repoPath} -> ${destination} (missing heading)`,
        ).toBe(true);
      }
    }
  }
});

test("code-spanned documentation paths do not drift", () => {
  const pathPattern = /`((?:(?:README|AGENTS|SECURITY)\.md|docs\/[A-Za-z0-9_./*-]+(?:\.md)?|integrations\/[A-Za-z0-9_./*-]+(?:\.md)?|agent\/prompts\/[A-Za-z0-9_./*-]+\.md)(?:#[A-Za-z0-9_-]+)?)`/g;
  for (const [repoPath, markdown] of docs) {
    for (const match of markdown.matchAll(pathPattern)) {
      const targetPath = match[1]!.split("#", 1)[0]!;
      if (targetPath.includes("*")) continue;
      expect(
        existsSync(join(root, targetPath)),
        `${repoPath} names missing ${targetPath}`,
      ).toBe(true);
    }
  }
});

test("public documentation blocks common private path and credential shapes", () => {
  const secretPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\bBearer\s+(?!<|YOUR_|TOKEN\b)[A-Za-z0-9._~-]{16,}\b/i,
    /\b(?:account_id|database_id)\s*=\s*["'][a-f0-9]{24,}["']/i,
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i,
    /\+[1-9][0-9]{9,14}\b/,
  ];
  for (const [repoPath, markdown] of docs) {
    expect(markdown, `${repoPath} contains an absolute user path`).not.toMatch(
      /\/Users\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\/i,
    );
    expect(markdown, `${repoPath} contains an OAuth authorization code`).not.toMatch(
      /cfoac_[A-Za-z0-9._~-]+/,
    );
    expect(markdown, `${repoPath} contains a user-specific launch namespace`).not.toMatch(
      /com\.[a-z0-9_-]+\.papertrail\b/i,
    );
    for (const pattern of secretPatterns) {
      expect(markdown, `${repoPath} matches private credential pattern ${pattern}`).not.toMatch(
        pattern,
      );
    }
    for (const email of markdown.matchAll(
      /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    )) {
      expect(
        ["example.com", "example.net", "example.org", "localhost.invalid"],
        `${repoPath} contains non-example recipient ${email[0]}`,
      ).toContain(email[1]!.toLowerCase());
    }
  }
});

test("entry routes and canonical document ownership stay clear", () => {
  const readme = docs.get("README.md")!;
  expect(readme).toContain("## Core archive commands");
  expect(readme).not.toContain("## Installed commands");
  expect(readme).toContain("wordhold drain");
  for (const route of [
    "docs/how-it-works.md",
    "docs/setup.md",
    "docs/operations.md",
    "docs/integrations.md",
    "docs/architecture.md",
    "docs/release-verification.md",
    "docs/source-provenance.md",
  ]) {
    expect(readme, `README route ${route}`).toContain(`](${route}`);
  }

  const operations = docs.get("docs/operations.md")!;
  const releases = docs.get("docs/release-verification.md")!;
  expect(operations).toContain("## Decommission a deployment");
  expect(operations).toContain("### Create and verify a backup");
  expect(operations).toContain('"$WORDHOLD" drain');
  expect(operations).toContain('"$WORDHOLD" rebuild');
  expect(operations).toContain('git -C "$DATA" cat-file -e "HEAD:$authority_path"');
  expect(operations).toContain('test "$(git -C "$DATA" rev-parse HEAD)" = "$SNAPSHOT_COMMIT"');
  expect(operations).toMatch(/verified Wordhold (?:archive|release)[\s*]+and[\s*]+receipt/i);
  expect(operations).not.toContain("scripts/release-candidate.ts");
  expect(operations).not.toMatch(/\bbun install\s*(?:\n|$)/);
  expect(releases).toContain("scripts/release-candidate.ts");
  expect(releases).toContain("PUBLIC RC QUALIFIED");

  const agents = docs.get("AGENTS.md")!;
  expect(agents).toContain("## Engineering map");
  expect(agents).toContain("docs/decisions/");
  expect(agents).not.toContain("docs/adr/");
});

test("owner documents retain the stable product, trust, and disclosure boundaries", () => {
  const readme = docs.get("README.md")!;
  expect(readme).toMatch(/local-first reading archive for one macOS user/);
  expect(readme).toMatch(/no reader UI or hosted account/i);
  expect(readme).toMatch(/optional[\s\S]{0,160}disabled until explicitly configured/i);
  expect(readme).toMatch(/ad-hoc signed[\s\S]{0,100}(?:rather than|not)[\s\S]{0,60}notarized/i);
  expect(readme).toMatch(/separate private data (?:Git )?repository/);
  expect(readme).toMatch(/model provider/);

  const howItWorks = docs.get("docs/how-it-works.md")!;
  expect(howItWorks).toMatch(/Queueing and archiving are different events/);
  expect(howItWorks).toMatch(/without issuing a Wordhold receipt/);
  expect(howItWorks).toMatch(/only after the daemon commits canonical\s+Markdown/);
  expect(howItWorks).toMatch(
    /canonical Markdown -> derived SQLite -> scoped Git commit -> acknowledgement/,
  );

  const security = docs.get("SECURITY.md")!;
  expect(security).toContain("Report a vulnerability");
  expect(security).toMatch(/Do not open a public issue with exploit details/);
  expect(security).toMatch(/revoke and replace it\s+immediately/);

  const shortcut = docs.get("integrations/shortcuts/Papertrail.md")!;
  expect(shortcut).toContain("send `POST`");
  expect(shortcut).toContain("/v1/save");
  expect(shortcut).toContain("CAPTURE_SECRET");
  expect(shortcut).toMatch(/exactly one[^\n]*URL/i);
  expect(shortcut).toMatch(/(?:no offline|offline queue|queue\s+offline)/i);

  const provenance = docs.get("docs/source-provenance.md")!;
  expect(provenance).toContain("https://github.com/adhd/wordhold.git");
  expect(provenance).toMatch(/history-free, audited snapshot/);
});

test("operator guides retain safety checks and define shell variables before use", () => {
  const setup = docs.get("docs/setup.md")!;
  for (const contract of [
    "./wordhold setup",
    "./wordhold update",
    "set -eu",
    "shasum -a 256 -c -",
    'codesign --verify --strict "$RELEASE/wordhold"',
    'xattr -dr com.apple.quarantine "$RELEASE"',
    "bun install --frozen-lockfile --ignore-scripts",
    'test "$(bun --revision)" = "1.3.11+af24e281e"',
    'PAPERTRAIL_APP_ROOT="$INSTALL_ROOT/current"',
    '"$DATA_ROOT/dist/papertrail-daemon"',
    '"$FDA_DAEMON"',
    '"$WORDHOLD" health',
  ]) {
    expect(setup, contract).toContain(contract);
  }
  expect(setup).not.toContain("spctl --master-disable");

  for (const [repoPath, guide] of [
    ["docs/setup.md", setup],
    ["docs/operations.md", docs.get("docs/operations.md")!],
  ] as const) {
    expect(undefinedShellVariables(guide), repoPath).toEqual([]);
  }

  const readme = docs.get("README.md")!;
  for (const match of readme.matchAll(/\]\(docs\/setup\.md#([^)]+)\)/g)) {
    const anchor = match[1]!;
    expect(
      undefinedShellVariables(sectionAtAnchor(setup, anchor)),
      `README direct route docs/setup.md#${anchor}`,
    ).toEqual([]);
  }

  const operations = docs.get("docs/operations.md")!;
  expect(operations).toContain("$APP/current/bin/papertrail-enrich");
  expect(operations).toContain('PAPERTRAIL_APP_ROOT="$APP/current"');
  expect(operations).toMatch(/unchanged[\s\S]{0,80}managed Codex\/Hermes/i);
  expect(operations).toMatch(/repair_required[\s\S]{0,180}stored[\s\S]{0,80}offer/i);
  expect(operations).toContain('"intent":"highlight"');
  expect(operations).toContain("### Digest and resurfacing effects");
  expect(setup).toContain("operations.md#digest-and-resurfacing-effects");

  const agentConnectionDocs = [
    docs.get("README.md")!,
    setup,
    docs.get("docs/integrations.md")!,
  ].join("\n");
  expect(agentConnectionDocs).not.toMatch(/probe(?:s|d)? (?:all )?(?:six|6) tools/i);
  expect(agentConnectionDocs).toMatch(/exact six[^\n]*tool names|exact six advertised tool names/i);
});

test("dependent or externally mutating shell examples fail closed", () => {
  const required = [
    ["README.md", "git clone https://github.com/adhd/wordhold.git"],
    ["README.md", "bun run build:distribution"],
    ["docs/setup.md", "EXPECTED_SHA256="],
    ["docs/setup.md", "bunx wrangler d1 create"],
    ["docs/setup.md", "bunx wrangler d1 migrations apply"],
    ["docs/operations.md", "cd /path/to/unpacked-wordhold-artifact"],
    ["docs/operations.md", "cd /path/to/unpacked-new-wordhold-artifact"],
    ["docs/operations.md", "bunx wrangler d1 migrations apply"],
    ["docs/operations.md", "bunx wrangler secret put CAPTURE_SECRET"],
    ["docs/operations.md", "before-rebuild-$STAMP"],
    ["docs/operations.md", 'git -C "$DATA" fsck --full --strict'],
    ["docs/release-verification.md", "git tag -a"],
    ["docs/release-verification.md", "gh release create"],
    ["docs/release-verification.md", "gh release edit"],
  ] as const;

  for (const [repoPath, marker] of required) {
    const matches = shellBlocks(docs.get(repoPath)!).filter((block) =>
      block.includes(marker)
    );
    expect(matches.length, `${repoPath} missing shell marker ${marker}`).toBeGreaterThan(0);
    for (const block of matches) {
      expect(block, `${repoPath} must fail closed around ${marker}`).toMatch(
        /^\s*\(\s*\n\s*set -eu\s*$/m,
      );
    }
  }

  const restoreBlock = shellBlocks(docs.get("docs/operations.md")!).find((block) =>
    block.includes('git -C "$DATA" fsck --full --strict')
  )!;
  for (const derived of ["papertrail.db", "papertrail.db-wal", "papertrail.db-shm"]) {
    expect(restoreBlock).toContain(derived);
  }
  expect(restoreBlock).toContain("preserved_file=");
  expect(restoreBlock).not.toContain('"$WORDHOLD" health');
});

test("copyable shell blocks do not encode commented alternatives", () => {
  for (const [repoPath, markdown] of docs) {
    for (const block of shellBlocks(markdown)) {
      expect(block, repoPath).not.toMatch(/^\s*#\s*(?:Or|Otherwise)\b/im);
      const clientMutations = new Set(
        Array.from(
          block.matchAll(/\b(?:connect|disconnect)\s+(codex|hermes)\b/g),
          (match) => match[1],
        ),
      );
      expect(clientMutations.size, `${repoPath} mutates both agent clients`).toBeLessThanOrEqual(1);

      const lifecycleMutations = Array.from(
        block.matchAll(/(?:\.\/wordhold\s+(?:setup|update)|"\$WORDHOLD"\s+uninstall)/g),
      );
      expect(lifecycleMutations.length, `${repoPath} combines lifecycle alternatives`).toBeLessThanOrEqual(1);
    }
  }
});
