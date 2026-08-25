import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  QUALIFIED_ONLINE_SHORTCUT_SHA256,
  verifyOnlineShortcutWorkflow,
  verifyQualifiedOnlineShortcut,
} from "../scripts/verify-online-shortcut.ts";

const sourceRoot = join(import.meta.dir, "..");

function actionParameters(
  workflow: Record<string, unknown>,
  index: number,
): Record<string, any> {
  const actions = workflow.WFWorkflowActions as Array<{
    WFWorkflowActionParameters: Record<string, any>;
  }>;
  return actions[index]!.WFWorkflowActionParameters;
}

test("bundled online Shortcut passes the shared build-time semantic gate", () => {
  const verified = verifyQualifiedOnlineShortcut(sourceRoot);
  expect(verified).toMatchObject({
    file: "Save to Papertrail — Online.shortcut",
    sha256: QUALIFIED_ONLINE_SHORTCUT_SHA256,
    version: "0.4.0",
  });
  expect(() => verifyOnlineShortcutWorkflow(verified.workflow)).not.toThrow();
});

test("semantic gate rejects changed Count and receipt-id condition bindings", () => {
  const { workflow } = verifyQualifiedOnlineShortcut(sourceRoot);

  const wrongCount = structuredClone(workflow);
  const wrongCountParameters = actionParameters(wrongCount, 4);
  wrongCountParameters.WFInput.Variable.Value.OutputUUID =
    actionParameters(wrongCount, 0).UUID;
  expect(() => verifyOnlineShortcutWorkflow(wrongCount)).toThrow(
    "one-URL Count condition binding changed",
  );

  const wrongReceipt = structuredClone(workflow);
  const wrongReceiptParameters = actionParameters(wrongReceipt, 8);
  wrongReceiptParameters.WFInput.Variable.Value.OutputUUID =
    actionParameters(wrongReceipt, 6).UUID;
  expect(() => verifyOnlineShortcutWorkflow(wrongReceipt)).toThrow(
    "receipt-id prefix condition binding changed",
  );
});

test("semantic gate rejects non-JSON request bodies and personalized shared bytes", () => {
  const { workflow } = verifyQualifiedOnlineShortcut(sourceRoot);

  const formBody = structuredClone(workflow);
  const formRequest = actionParameters(formBody, 6);
  formRequest.WFFormValues = formRequest.WFJSONValues;
  delete formRequest.WFJSONValues;
  expect(() => verifyOnlineShortcutWorkflow(formBody)).toThrow(
    "HTTP body is not the single native JSON body",
  );

  const personalized = structuredClone(workflow);
  actionParameters(personalized, 0).WFTextActionText =
    "https://private-worker.invalid/v1/save";
  expect(() => verifyOnlineShortcutWorkflow(personalized)).toThrow(
    "generic empty endpoint field changed",
  );
});
