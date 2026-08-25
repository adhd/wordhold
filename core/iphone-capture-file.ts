export type IphoneCaptureFile =
  | {
      kind: "link";
      version: "0.3.7";
      identity: `${number}-${number}`;
      extension: "txt";
      buildMarker: string;
    }
  | { kind: "legacy" };

const LINK_CAPTURE_037 =
  /^papertrail-link-(0\.3\.7)-([1-9][0-9]{8})-([1-9][0-9]{8})\.txt$/;
const LEGACY_JSON_CAPTURE = /^papertrail-.*\.json$/;

/**
 * Classifies only queue files owned by the legacy Papertrail iCloud client. Link candidates carry a
 * versioned filename/marker contract; legacy JSON keeps its existing parser.
 */
export function classifyIphoneCaptureFile(
  name: string,
): IphoneCaptureFile | null {
  const link = LINK_CAPTURE_037.exec(name);
  if (link) {
    const [, version, first, second] = link;
    return {
      kind: "link",
      version: version! as "0.3.7",
      identity: `${first}-${second}` as `${number}-${number}`,
      extension: "txt",
      buildMarker: `papertrail-link-${version}`,
    };
  }
  return LEGACY_JSON_CAPTURE.test(name) ? { kind: "legacy" } : null;
}

export function isIphoneCapturePlaceholder(name: string): boolean {
  if (!name.endsWith(".icloud")) return false;
  const inner = name.replace(/^\./, "").slice(0, -".icloud".length);
  return classifyIphoneCaptureFile(inner) !== null;
}

export function isRejectedIphoneCaptureFile(name: string): boolean {
  if (classifyIphoneCaptureFile(name)) return true;
  const collision = /^(.*)\.([1-9][0-9]*)$/.exec(name);
  return collision ? classifyIphoneCaptureFile(collision[1]!) !== null : false;
}
