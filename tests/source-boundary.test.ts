import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CANONICAL_SOURCE_REMOTE,
  verifySourceBoundary,
} from "../scripts/verify-source-boundary.ts";

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pt-source-boundary-"));
  git(root, "init", "-q", "--template=", "-b", "main");
  git(root, "config", "user.name", "Papertrail Test");
  git(root, "config", "user.email", "papertrail@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

function commitFixture(root: string, contents = "reviewed source\n"): void {
  writeFileSync(join(root, "README.md"), contents);
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add reviewed source");
}

test("strict release source verification allows only the canonical credential-free origin", () => {
  const root = repository();
  try {
    commitFixture(root);
    expect(() => verifySourceBoundary({
      root,
      requireCanonicalReleaseContext: true,
    })).toThrow(/unexpected source remote: none/i);
    git(root, "remote", "add", "origin", CANONICAL_SOURCE_REMOTE);
    expect(() => verifySourceBoundary({
      root,
      requireCanonicalReleaseContext: true,
    })).not.toThrow();

    git(root, "remote", "set-url", "--push", "origin", "https://github.com/other/wordhold.git");
    expect(() => verifySourceBoundary({
      root,
      requireCanonicalReleaseContext: true,
    })).toThrow(/canonical origin/i);
    git(root, "remote", "set-url", "--delete", "--push", "origin", "https://github.com/other/wordhold.git");

    git(root, "remote", "add", "upstream", CANONICAL_SOURCE_REMOTE);
    expect(() => verifySourceBoundary({
      root,
      requireCanonicalReleaseContext: true,
    })).toThrow(/unexpected source remote/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable source verification accepts fork remotes and development refs", () => {
  const root = repository();
  try {
    commitFixture(root);
    git(root, "remote", "add", "origin", "https://github.com/contributor/wordhold.git");
    git(root, "remote", "add", "upstream", CANONICAL_SOURCE_REMOTE);
    git(root, "branch", "feature/public-ci");
    expect(() => verifySourceBoundary({ root })).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict release source verification rejects unexpected refs", () => {
  const root = repository();
  try {
    commitFixture(root);
    git(root, "remote", "add", "origin", CANONICAL_SOURCE_REMOTE);
    git(root, "branch", "unexpected");
    expect(() => verifySourceBoundary({
      root,
      requireCanonicalReleaseContext: true,
    })).toThrow(/unexpected source ref/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source verification rejects provider credentials in reachable history", () => {
  const root = repository();
  try {
    const credential = ["github", "pat", "11AA22BB33CC44DD55EE66FF77GG88HH99II"]
      .join("_");
    commitFixture(root, `${credential}\n`);
    expect(() => verifySourceBoundary({ root })).toThrow(/private content marker/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source verification can reject an explicitly identified predecessor object", () => {
  const root = repository();
  try {
    commitFixture(root);
    const predecessor = git(root, "rev-parse", "HEAD");
    expect(() => verifySourceBoundary({ root, forbiddenObject: predecessor }))
      .toThrow(/forbidden predecessor object/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source verification scans test fixtures and deleted reachable blobs", () => {
  const privatePath = ["", "Users", "private-owner", "Cognos"].join("/");
  for (const deleted of [false, true]) {
    const root = repository();
    try {
      const fixture = join(root, "tests", "fixture.txt");
      mkdirSync(join(root, "tests"));
      writeFileSync(fixture, `${privatePath}\n`);
      git(root, "add", "tests/fixture.txt");
      git(root, "commit", "-qm", "add fixture");
      if (deleted) {
        unlinkSync(fixture);
        git(root, "add", "-u");
        git(root, "commit", "-qm", "remove fixture");
      }
      expect(() => verifySourceBoundary({ root })).toThrow(
        /private content marker in (?:tests|history)/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("portable verification scans deleted blobs behind a detached CI HEAD", () => {
  const root = repository();
  try {
    commitFixture(root);
    git(root, "checkout", "-qb", "candidate");
    const privatePath = ["", "Users", "private-owner", "detached-history"].join("/");
    writeFileSync(join(root, "README.md"), `${privatePath}\n`);
    git(root, "commit", "-qam", "add private candidate history");
    writeFileSync(join(root, "README.md"), "reviewed source\n");
    git(root, "commit", "-qam", "remove private candidate history");
    git(root, "checkout", "--detach");
    git(root, "branch", "-D", "candidate");

    expect(() => verifySourceBoundary({ root })).toThrow(
      /private content marker in history/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable source verification scans private content reachable only from a development ref", () => {
  const root = repository();
  try {
    commitFixture(root);
    git(root, "checkout", "-qb", "feature/private-history");
    const privatePath = ["", "Users", "private-owner", "Cognos"].join("/");
    writeFileSync(join(root, "README.md"), `${privatePath}\n`);
    git(root, "commit", "-qam", "add unsafe feature content");
    git(root, "checkout", "-q", "main");
    expect(() => verifySourceBoundary({ root })).toThrow(
      /private content marker in history/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source verification rejects tracked credential files by path", () => {
  for (const path of [".env", ".env.local", "worker/.dev.vars", ".scratch/issue.md"]) {
    const root = repository();
    try {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "PLACEHOLDER=value\n");
      git(root, "add", path);
      git(root, "commit", "-qm", "add private local file");
      expect(() => verifySourceBoundary({ root })).toThrow(`private path is tracked: ${path}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("source verification rejects populated Worker secret assignments", () => {
  const root = repository();
  try {
    const variable = ["CAPTURE", "SECRET"].join("_");
    commitFixture(root, `${variable}=${"private-value".repeat(3)}\n`);
    expect(() => verifySourceBoundary({ root })).toThrow(/private content marker/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source verification rejects shallow history", () => {
  const container = mkdtempSync(join(tmpdir(), "pt-source-shallow-"));
  const origin = join(container, "origin");
  const clone = join(container, "clone");
  try {
    git(container, "init", "-q", "--template=", "-b", "main", origin);
    git(origin, "config", "user.name", "Papertrail Test");
    git(origin, "config", "user.email", "papertrail@example.invalid");
    git(origin, "config", "commit.gpgsign", "false");
    const privatePath = ["", "Users", "private-owner", "private-history"].join("/");
    writeFileSync(join(origin, "README.md"), `${privatePath}\n`);
    git(origin, "add", "README.md");
    git(origin, "commit", "-qm", "add private predecessor");
    writeFileSync(join(origin, "README.md"), "reviewed source\n");
    git(origin, "commit", "-qam", "remove private predecessor");

    git(container, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
    git(clone, "remote", "set-url", "origin", CANONICAL_SOURCE_REMOTE);

    expect(() => verifySourceBoundary({ root: clone })).toThrow(/shallow/i);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("source verification rejects legacy grafts that hide history", () => {
  const root = repository();
  try {
    const privatePath = ["", "Users", "private-owner", "private-history"].join("/");
    commitFixture(root, `${privatePath}\n`);
    writeFileSync(join(root, "README.md"), "reviewed source\n");
    git(root, "commit", "-qam", "remove private predecessor");

    const commonDir = resolve(root, git(root, "rev-parse", "--git-common-dir"));
    mkdirSync(join(commonDir, "info"), { recursive: true });
    writeFileSync(join(commonDir, "info", "grafts"), `${git(root, "rev-parse", "HEAD")}\n`);
    expect(git(root, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(() => verifySourceBoundary({ root })).toThrow(/graft/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
