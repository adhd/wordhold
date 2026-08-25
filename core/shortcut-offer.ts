import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type ShortcutOfferStatus =
  | "withdrawn"
  | "qualification_only"
  | "owner_qualified";

export interface ShortcutOffer {
  format: 1;
  version: string;
  workflowName: string;
  status: ShortcutOfferStatus;
  sha256: string;
  buildMarker: string | null;
}

type ShortcutOfferAction = "setup" | "approve";

const OFFER_PATH = join("integrations", "shortcuts", "Papertrail.offer.json");
export const SHORTCUT_FILE = "Save to Papertrail — Online.shortcut";
const SHORTCUT_PATH = join("integrations", "shortcuts", SHORTCUT_FILE);

function regularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return realpathSync(absolute);
}

function parseOffer(value: unknown): ShortcutOffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shortcut offer metadata must be an object");
  }
  const input = value as Record<string, unknown>;
  const status = input.status;
  if (
    input.format !== 1 ||
    typeof input.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(input.version) ||
    typeof input.workflowName !== "string" ||
    input.workflowName.length === 0 ||
    (status !== "withdrawn" &&
      status !== "qualification_only" &&
      status !== "owner_qualified") ||
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    (input.buildMarker !== null && typeof input.buildMarker !== "string")
  ) {
    throw new Error("Shortcut offer metadata is invalid");
  }
  return {
    format: 1,
    version: input.version,
    workflowName: input.workflowName,
    status,
    sha256: input.sha256,
    buildMarker: input.buildMarker,
  };
}

export function readShortcutOffer(rawSourceRoot: string): ShortcutOffer {
  const sourceRoot = realpathSync(resolve(rawSourceRoot));
  const metadataPath = regularFile(join(sourceRoot, OFFER_PATH), "Shortcut offer metadata");
  const shortcutPath = regularFile(join(sourceRoot, SHORTCUT_PATH), "Shortcut artifact");
  const offer = parseOffer(JSON.parse(readFileSync(metadataPath, "utf8")));
  const actual = createHash("sha256").update(readFileSync(shortcutPath)).digest("hex");
  if (actual !== offer.sha256) {
    throw new Error("Shortcut offer digest does not match the bundled artifact");
  }
  return offer;
}

export function shortcutQualification(
  offer: ShortcutOffer,
  exactDigestApproved = false,
): ShortcutOfferStatus {
  if (offer.status === "withdrawn") return "withdrawn";
  if (offer.status === "qualification_only" && exactDigestApproved) {
    return "owner_qualified";
  }
  return offer.status;
}

export function assertShortcutOfferAction(
  offer: ShortcutOffer,
  action: ShortcutOfferAction,
  options: { qualificationObserved?: boolean } = {},
): void {
  if (offer.status === "withdrawn") {
    throw new Error(
      `Papertrail ${offer.version} bundles a withdrawn iPhone Shortcut; ${action} is disabled`,
    );
  }
  if (
    action === "approve" &&
    offer.status === "qualification_only" &&
    options.qualificationObserved !== true
  ) {
    throw new Error(
      "the offered Shortcut is qualification-only; record approval only after its bounded live device gate passes",
    );
  }
}
