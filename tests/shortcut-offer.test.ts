import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertShortcutOfferAction,
  readShortcutOffer,
  shortcutQualification,
} from "../core/shortcut-offer.ts";

const sourceRoot = join(import.meta.dir, "..");

test("the bundled online Shortcut is the exact owner-qualified offer", () => {
  const offer = readShortcutOffer(sourceRoot);

  expect(offer).toMatchObject({
    format: 1,
    version: "0.4.0",
    workflowName: "Save to Papertrail — Online",
    status: "owner_qualified",
    sha256: "ff657efe92c04583586797e633a89a1d66d1287108f4d76b19880288ffde8d95",
    buildMarker: null,
  });
  expect(shortcutQualification(offer)).toBe("owner_qualified");
  expect(shortcutQualification(offer, true)).toBe("owner_qualified");
  expect(() => assertShortcutOfferAction(offer, "setup")).not.toThrow();
  expect(() => assertShortcutOfferAction(offer, "approve")).not.toThrow();
});
