import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateThirdPartyNotices,
  verifyThirdPartyLicenses,
  verifyThirdPartyNotices,
} from "../scripts/verify-third-party-licenses.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function packageFixture(
  nodeModules: string,
  name: string,
  version: string,
  license: string,
  notice: string,
): void {
  const root = join(nodeModules, ...name.split("/"));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name,
    version,
    license,
  }));
  writeFileSync(join(root, "LICENSE"), notice);
}

test("third-party notices preserve every package identity and exact license notice", () => {
  const root = mkdtempSync(join(tmpdir(), "wordhold-license-fixture-"));
  roots.push(root);
  const nodeModules = join(root, "node_modules");
  mkdirSync(nodeModules);
  packageFixture(
    nodeModules,
    "alpha",
    "1.2.3",
    "MIT",
    "Copyright Alpha\n\nPermission text.\n",
  );
  packageFixture(
    nodeModules,
    "@scope/beta",
    "4.5.6",
    "BSD-2-Clause",
    "Copyright Beta\n\nRedistribution text.\n",
  );

  const notices = generateThirdPartyNotices(nodeModules);
  expect(notices).toContain("alpha@1.2.3 — MIT");
  expect(notices).toContain("@scope/beta@4.5.6 — BSD-2-Clause");
  expect(notices).toContain("Copyright Alpha\n\nPermission text.\n");
  expect(notices).toContain("Copyright Beta\n\nRedistribution text.\n");
});

test("license verification fails closed when checked-in package notices are stale", () => {
  const root = mkdtempSync(join(tmpdir(), "wordhold-license-stale-"));
  roots.push(root);
  const nodeModules = join(root, "node_modules");
  mkdirSync(nodeModules);
  packageFixture(nodeModules, "alpha", "1.2.3", "MIT", "Copyright Alpha\n");
  const noticePath = join(root, "THIRD_PARTY_NOTICES.md");
  writeFileSync(noticePath, generateThirdPartyNotices(nodeModules));
  expect(() => verifyThirdPartyNotices(noticePath, nodeModules)).not.toThrow();

  appendFileSync(noticePath, "unreviewed change\n");
  expect(() => verifyThirdPartyNotices(noticePath, nodeModules))
    .toThrow("third-party notices are missing, stale, or mismatched");
});

test("adding a production package blocks until its notice is regenerated", () => {
  const root = mkdtempSync(join(tmpdir(), "wordhold-license-added-package-"));
  roots.push(root);
  const nodeModules = join(root, "node_modules");
  mkdirSync(nodeModules);
  packageFixture(nodeModules, "alpha", "1.2.3", "MIT", "Copyright Alpha\n");
  const noticePath = join(root, "THIRD_PARTY_NOTICES.md");
  writeFileSync(noticePath, generateThirdPartyNotices(nodeModules));

  packageFixture(
    nodeModules,
    "beta",
    "2.0.0",
    "Apache-2.0",
    "Copyright Beta\n",
  );
  expect(() => verifyThirdPartyNotices(noticePath, nodeModules))
    .toThrow("third-party notices are missing, stale, or mismatched");
});

test("the checked-in public license set matches Bun and installed production packages", () => {
  const sourceRoot = join(import.meta.dir, "..");
  const verified = verifyThirdPartyLicenses({
    sourceRoot,
    nodeModules: join(sourceRoot, "node_modules"),
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
  });
  expect(verified.bunVersion).toBe("1.3.11");
  expect(verified.bunRevision).toBe(
    "af24e281ebacd6ac77c0f14b4206599cf4ae1c9f",
  );
  expect(verified.packages).toBeGreaterThan(100);
  expect(() => verifyThirdPartyLicenses({
    sourceRoot,
    nodeModules: join(sourceRoot, "node_modules"),
    bunVersion: "1.3.12",
    bunRevision: Bun.revision,
  })).toThrow("Bun runtime license set covers 1.3.11, not 1.3.12");
  expect(() => verifyThirdPartyLicenses({
    sourceRoot,
    nodeModules: join(sourceRoot, "node_modules"),
    bunVersion: Bun.version,
    bunRevision: "0".repeat(40),
  })).toThrow("Bun runtime source notice covers");
});
