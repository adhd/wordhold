// Build-time verifier for the frozen, generic online iPhone Shortcut. The AEA
// envelope is opaque to ordinary byte scans, so release construction decrypts
// it and proves the actual workflow before copying it into a distribution.
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readShortcutOffer,
  SHORTCUT_FILE,
} from "../core/shortcut-offer.ts";

export const QUALIFIED_ONLINE_SHORTCUT_SHA256 =
  "ff657efe92c04583586797e633a89a1d66d1287108f4d76b19880288ffde8d95";

type JsonObject = Record<string, unknown>;

interface ShortcutAction {
  WFWorkflowActionIdentifier: string;
  WFWorkflowActionParameters: JsonObject;
}

export interface VerifiedOnlineShortcut {
  file: typeof SHORTCUT_FILE;
  sha256: typeof QUALIFIED_ONLINE_SHORTCUT_SHA256;
  version: "0.4.0";
  workflow: JsonObject;
}

function fail(reason: string): never {
  throw new Error(`online Shortcut verification failed: ${reason}`);
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  return value as JsonObject;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) fail(`${label} changed`);
}

function uuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value)
  ) {
    fail(`${label} UUID is invalid`);
  }
  return value;
}

function tokenString(
  string: string,
  attachment?: { range: string; value: JsonObject },
): JsonObject {
  return {
    Value: {
      string,
      ...(attachment
        ? { attachmentsByRange: { [attachment.range]: attachment.value } }
        : {}),
    },
    WFSerializationType: "WFTextTokenString",
  };
}

function tokenAttachment(value: JsonObject): JsonObject {
  return {
    Value: value,
    WFSerializationType: "WFTextTokenAttachment",
  };
}

function actionOutput(
  outputUuid: string,
  outputName: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    OutputUUID: outputUuid,
    Type: "ActionOutput",
    OutputName: outputName,
    ...extra,
  };
}

function dictionaryItem(key: string, value: JsonObject): JsonObject {
  return {
    WFKey: tokenString(key),
    WFItemType: 0,
    WFValue: value,
  };
}

function dictionary(items: JsonObject[]): JsonObject {
  return {
    Value: { WFDictionaryFieldValueItems: items },
    WFSerializationType: "WFDictionaryFieldValue",
  };
}

function parameters(action: ShortcutAction, index: number): JsonObject {
  return object(
    action.WFWorkflowActionParameters,
    `action ${index} parameters`,
  );
}

/**
 * Pure semantic verification, exported so regression tests can mutate a
 * decoded copy and prove that each decisive dataflow edge fails closed.
 */
export function verifyOnlineShortcutWorkflow(value: unknown): void {
  const workflow = object(value, "workflow");
  const actionsValue = workflow.WFWorkflowActions;
  if (!Array.isArray(actionsValue)) fail("actions are missing");
  const actions = actionsValue.map((entry, index): ShortcutAction => {
    const action = object(entry, `action ${index}`);
    if (
      typeof action.WFWorkflowActionIdentifier !== "string" ||
      typeof action.WFWorkflowActionParameters !== "object" ||
      action.WFWorkflowActionParameters === null ||
      Array.isArray(action.WFWorkflowActionParameters)
    ) {
      fail(`action ${index} shape is invalid`);
    }
    return action as unknown as ShortcutAction;
  });

  const metadata = { ...workflow };
  delete metadata.WFWorkflowActions;
  exact(metadata, {
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowIcon: {
      WFWorkflowIconStartColor: 946986751,
      WFWorkflowIconGlyphNumber: 61440,
    },
    WFWorkflowClientVersion: "4610",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowInputContentItemClasses: [
      "WFStringContentItem",
      "WFSafariWebPageContentItem",
      "WFURLContentItem",
    ],
    WFWorkflowImportQuestions: [
      {
        ParameterKey: "WFTextActionText",
        Category: "Parameter",
        ActionIndex: 0,
        Text: "Papertrail Worker save URL?",
        DefaultValue: "",
      },
      {
        ParameterKey: "WFTextActionText",
        Category: "Parameter",
        ActionIndex: 1,
        Text: "Papertrail capture token?",
        DefaultValue: "",
      },
    ],
    WFQuickActionSurfaces: [],
    WFWorkflowTypes: [
      "ActionExtension",
      "WFWorkflowTypeShowInSearch",
    ],
    WFWorkflowHasShortcutInputVariables: true,
  }, "workflow metadata and generic import questions");

  exact(actions.map((action) => action.WFWorkflowActionIdentifier), [
    "is.workflow.actions.gettext",
    "is.workflow.actions.gettext",
    "is.workflow.actions.detect.link",
    "is.workflow.actions.count",
    "is.workflow.actions.conditional",
    "is.workflow.actions.getitemfromlist",
    "is.workflow.actions.downloadurl",
    "is.workflow.actions.getvalueforkey",
    "is.workflow.actions.conditional",
    "is.workflow.actions.notification",
    "is.workflow.actions.conditional",
    "is.workflow.actions.alert",
    "is.workflow.actions.conditional",
    "is.workflow.actions.conditional",
    "is.workflow.actions.alert",
    "is.workflow.actions.conditional",
  ], "exact one-URL action graph");

  const [endpoint, token, links, count, outerStart, first, request, receipt,
    innerStart, success, innerElse, invalidReceipt, innerEnd, outerElse,
    invalidInput, outerEnd] = actions;
  if (
    !endpoint || !token || !links || !count || !outerStart || !first ||
    !request || !receipt || !innerStart || !success || !innerElse ||
    !invalidReceipt || !innerEnd || !outerElse || !invalidInput || !outerEnd
  ) {
    fail("exact action graph is incomplete");
  }

  const endpointUuid = uuid(parameters(endpoint, 0).UUID, "endpoint");
  const tokenUuid = uuid(parameters(token, 1).UUID, "token");
  const linksUuid = uuid(parameters(links, 2).UUID, "URL extraction");
  const countUuid = uuid(parameters(count, 3).UUID, "URL count");
  const firstUuid = uuid(parameters(first, 5).UUID, "first URL");
  const requestUuid = uuid(parameters(request, 6).UUID, "HTTP request");
  const receiptUuid = uuid(parameters(receipt, 7).UUID, "receipt id");
  const successUuid = uuid(parameters(success, 9).UUID, "success notification");
  const innerEndUuid = uuid(parameters(innerEnd, 12).UUID, "receipt condition end");
  const outerEndUuid = uuid(parameters(outerEnd, 15).UUID, "URL count condition end");
  const allUuids = [
    endpointUuid,
    tokenUuid,
    linksUuid,
    countUuid,
    firstUuid,
    requestUuid,
    receiptUuid,
    successUuid,
    innerEndUuid,
    outerEndUuid,
  ];
  if (new Set(allUuids).size !== allUuids.length) {
    fail("action UUIDs are not unique");
  }

  const outerGroup = uuid(
    parameters(outerStart, 4).GroupingIdentifier,
    "URL count condition",
  );
  const innerGroup = uuid(
    parameters(innerStart, 8).GroupingIdentifier,
    "receipt condition",
  );
  if (outerGroup === innerGroup) fail("condition groups are not independent");

  exact(parameters(endpoint, 0), {
    UUID: endpointUuid,
    WFTextActionText: "",
  }, "generic empty endpoint field");
  exact(parameters(token, 1), {
    UUID: tokenUuid,
    WFTextActionText: "",
  }, "generic empty token field");
  exact(parameters(links, 2), {
    WFInput: tokenString("￼", {
      range: "{0, 1}",
      value: { Type: "ExtensionInput" },
    }),
    UUID: linksUuid,
  }, "Shortcut Input to URL extraction binding");
  exact(parameters(count, 3), {
    Input: tokenAttachment(actionOutput(linksUuid, "URLs")),
    UUID: countUuid,
  }, "URL extraction to Count binding");
  exact(parameters(outerStart, 4), {
    WFCondition: 4,
    WFInput: {
      Type: "Variable",
      Variable: tokenAttachment(actionOutput(countUuid, "Count")),
    },
    WFControlFlowMode: 0,
    GroupingIdentifier: outerGroup,
    WFNumberValue: "1",
  }, "one-URL Count condition binding");
  exact(parameters(first, 5), {
    WFInput: tokenAttachment(actionOutput(linksUuid, "URLs")),
    UUID: firstUuid,
  }, "first URL binding");

  const requestParameters = parameters(request, 6);
  if (
    !("WFJSONValues" in requestParameters) ||
    "WFFormValues" in requestParameters ||
    "WFRequestVariable" in requestParameters ||
    "WFFile" in requestParameters
  ) {
    fail("HTTP body is not the single native JSON body");
  }
  exact(requestParameters, {
    WFHTTPHeaders: dictionary([
      dictionaryItem("Authorization", tokenString("Bearer ￼", {
        range: "{7, 1}",
        value: actionOutput(tokenUuid, "Text"),
      })),
    ]),
    ShowHeaders: true,
    UUID: requestUuid,
    WFURL: tokenString("￼", {
      range: "{0, 1}",
      value: actionOutput(endpointUuid, "Text"),
    }),
    WFJSONValues: dictionary([
      dictionaryItem("url", tokenString("￼", {
        range: "{0, 1}",
        value: actionOutput(firstUuid, "Item from List"),
      })),
    ]),
    WFHTTPMethod: "POST",
  }, "HTTPS endpoint, JSON {url}, and Bearer token dataflow");

  exact(parameters(receipt, 7), {
    WFInput: tokenAttachment(actionOutput(requestUuid, "Contents of URL")),
    UUID: receiptUuid,
    WFDictionaryKey: "id",
  }, "HTTP response to receipt-id binding");
  exact(parameters(innerStart, 8), {
    WFInput: {
      Type: "Variable",
      Variable: tokenAttachment(actionOutput(
        receiptUuid,
        "Dictionary Value",
        {
          Aggrandizements: [{
            Type: "WFCoercionVariableAggrandizement",
            CoercionItemClass: "WFStringContentItem",
          }],
        },
      )),
    },
    WFControlFlowMode: 0,
    WFConditionalActionString: "in_",
    GroupingIdentifier: innerGroup,
    WFCondition: 8,
  }, "receipt-id prefix condition binding");
  exact(parameters(success, 9), {
    WFNotificationActionBody: tokenString("Accepted by Papertrail: ￼", {
      range: "{24, 1}",
      value: actionOutput(receiptUuid, "Dictionary Value"),
    }),
    UUID: successUuid,
  }, "success receipt notification");
  exact(parameters(innerElse, 10), {
    GroupingIdentifier: innerGroup,
    WFControlFlowMode: 1,
  }, "invalid-receipt else branch");
  exact(parameters(invalidReceipt, 11), {
    WFAlertActionMessage: "Papertrail did not return a valid queue receipt.",
  }, "invalid-receipt message");
  exact(parameters(innerEnd, 12), {
    UUID: innerEndUuid,
    GroupingIdentifier: innerGroup,
    WFControlFlowMode: 2,
  }, "receipt condition end");
  exact(parameters(outerElse, 13), {
    GroupingIdentifier: outerGroup,
    WFControlFlowMode: 1,
  }, "invalid-input else branch");
  exact(parameters(invalidInput, 14), {
    WFAlertActionMessage: "Papertrail needs exactly one web URL.",
  }, "invalid-input message");
  exact(parameters(outerEnd, 15), {
    UUID: outerEndUuid,
    GroupingIdentifier: outerGroup,
    WFControlFlowMode: 2,
  }, "URL count condition end");

  // Every top-level field and action parameter is already allowlisted above.
  // These markers are an additional readable guard against accidentally
  // qualifying a personalized/private or legacy local-file workflow.
  const serialized = JSON.stringify(workflow);
  for (const marker of [
    /https?:\/\//i,
    /workers\.dev/i,
    /\/Users\//i,
    /papertrail-link-/i,
    /documentpicker\.save/i,
    /number\.random/i,
    /CurrentDate/,
  ]) {
    if (marker.test(serialized)) fail("workflow contains a private or legacy literal");
  }
}

function runTool(args: string[], label: string): Uint8Array {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  } catch {
    fail(`${label} tool is unavailable`);
  }
  if (result.exitCode !== 0) fail(`${label} did not succeed`);
  if (!result.stdout) fail(`${label} did not return readable output`);
  return result.stdout;
}

function decodeSignedShortcut(artifact: string, bytes: Buffer): JsonObject {
  if (bytes.byteLength < 4 || bytes.subarray(0, 4).toString() !== "AEA1") {
    fail("artifact is not an Apple AEA1 envelope");
  }
  const chainLabel = bytes.indexOf(Buffer.from("SigningCertificateChain"));
  if (chainLabel < 0) fail("signing certificate chain is missing");
  let certificateOffset = -1;
  for (
    let index = chainLabel;
    index < Math.min(bytes.length - 4, chainLabel + 128);
    index += 1
  ) {
    if (bytes[index] === 0x30 && bytes[index + 1] === 0x82) {
      certificateOffset = index;
      break;
    }
  }
  if (certificateOffset < 0 || certificateOffset + 4 > bytes.length) {
    fail("leaf signing certificate is missing");
  }
  const certificateLength = bytes.readUInt16BE(certificateOffset + 2) + 4;
  if (
    certificateLength <= 4 ||
    certificateOffset + certificateLength > bytes.length
  ) {
    fail("leaf signing certificate is malformed");
  }

  const scratch = mkdtempSync(join(tmpdir(), "papertrail-shortcut-verify-"));
  try {
    const certificate = join(scratch, "leaf.der");
    const publicKey = join(scratch, "leaf.pem");
    const archive = join(scratch, "shortcut.aar");
    const extracted = join(scratch, "extracted");
    const workflowJson = join(scratch, "Shortcut.json");
    writeFileSync(
      certificate,
      bytes.subarray(
        certificateOffset,
        certificateOffset + certificateLength,
      ),
      { mode: 0o600 },
    );
    writeFileSync(publicKey, runTool([
      "/usr/bin/openssl",
      "x509",
      "-inform",
      "DER",
      "-in",
      certificate,
      "-pubkey",
      "-noout",
    ], "certificate inspection"), { mode: 0o600 });
    runTool([
      "/usr/bin/aea",
      "decrypt",
      "-i",
      artifact,
      "-o",
      archive,
      "-sign-pub",
      publicKey,
    ], "signed envelope verification");
    const members = new TextDecoder().decode(runTool([
      "/usr/bin/aa",
      "list",
      "-i",
      archive,
    ], "Shortcut archive listing")).split("\n").map((line) => line.trim())
      .filter(Boolean);
    exact(members, ["Shortcut.wflow"], "Shortcut archive inventory");
    mkdirSync(extracted, { mode: 0o700 });
    runTool([
      "/usr/bin/aa",
      "extract",
      "-i",
      archive,
      "-d",
      extracted,
    ], "Shortcut archive extraction");
    exact(readdirSync(extracted), ["Shortcut.wflow"], "extracted Shortcut inventory");
    const workflowPath = join(extracted, "Shortcut.wflow");
    const workflowStat = lstatSync(workflowPath);
    if (workflowStat.isSymbolicLink() || !workflowStat.isFile()) {
      fail("Shortcut.wflow is not a regular file");
    }
    runTool([
      "/usr/bin/plutil",
      "-convert",
      "json",
      "-o",
      workflowJson,
      workflowPath,
    ], "Shortcut plist conversion");
    if (statSync(workflowJson).size > 1024 * 1024) {
      fail("decoded workflow exceeds the verification bound");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(workflowJson, "utf8"));
    } catch {
      fail("decoded workflow is not valid JSON");
    }
    return object(parsed, "decoded workflow");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Verify offer identity, signature envelope, decoded graph, and private-value absence. */
export function verifyQualifiedOnlineShortcut(
  rawSourceRoot: string,
): VerifiedOnlineShortcut {
  const sourceRoot = realpathSync(resolve(rawSourceRoot));
  const offer = readShortcutOffer(sourceRoot);
  exact(offer, {
    format: 1,
    version: "0.4.0",
    workflowName: "Save to Papertrail — Online",
    status: "owner_qualified",
    sha256: QUALIFIED_ONLINE_SHORTCUT_SHA256,
    buildMarker: null,
  }, "qualified offer identity");
  const artifact = join(
    sourceRoot,
    "integrations",
    "shortcuts",
    SHORTCUT_FILE,
  );
  const bytes = readFileSync(artifact);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== QUALIFIED_ONLINE_SHORTCUT_SHA256) {
    fail("artifact digest is not the qualified digest");
  }
  const workflow = decodeSignedShortcut(artifact, bytes);
  verifyOnlineShortcutWorkflow(workflow);
  return {
    file: SHORTCUT_FILE,
    sha256: QUALIFIED_ONLINE_SHORTCUT_SHA256,
    version: "0.4.0",
    workflow,
  };
}
