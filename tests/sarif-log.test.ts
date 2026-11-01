import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  CHECK_RULES,
  fileStep,
  folderStep,
  type CheckOutcome,
} from "../src/application/checkSteps.js";
import {
  artifactUri,
  logicalName,
  pathWithin,
  sarifLog,
} from "../src/infrastructure/sarifLog.js";

const root = "/consumer";
const options = { root, version: "0.1.0" };

interface Run {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly rules: readonly { readonly id: string }[];
    };
  };
  readonly invocations: readonly {
    readonly executionSuccessful: boolean;
    readonly toolExecutionNotifications?: readonly {
      readonly level: string;
    }[];
  }[];
  readonly results?: readonly Record<string, unknown>[];
  readonly columnKind: string;
}

function onlyRun(outcome: CheckOutcome): Run {
  const log = sarifLog(outcome, options) as { runs: readonly Run[] };
  assert.equal(log.runs.length, 1);
  return log.runs[0]!;
}

test("a complete check writes a successful run without results", () => {
  const run = onlyRun({ kind: "complete" });
  assert.equal(run.tool.driver.name, "kataskeue");
  assert.equal(run.tool.driver.version, "0.1.0");
  assert.deepEqual(
    run.tool.driver.rules.map((rule) => rule.id),
    Object.keys(CHECK_RULES),
  );
  assert.deepEqual(run.invocations, [{ executionSuccessful: true }]);
  assert.deepEqual(run.results, []);
  assert.equal(run.columnKind, "utf16CodeUnits");
});

test("a drift writes one located result in an incomplete run", () => {
  const receipt = join(root, "vault", ".obsidian", "plugin-installation.json");
  const run = onlyRun({
    kind: "drift",
    step: fileStep("receipt/profile", receipt, "/profile_digest"),
    message: "installation receipt belongs to another canonical profile",
  });
  assert.equal(run.invocations[0]?.executionSuccessful, false);
  assert.equal(
    run.invocations[0]?.toolExecutionNotifications?.[0]?.level,
    "error",
  );
  assert.deepEqual(run.results, [
    {
      ruleId: "receipt/profile",
      level: "error",
      message: {
        text: "installation receipt belongs to another canonical profile",
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: "vault/.obsidian/plugin-installation.json",
              uriBaseId: "SRCROOT",
            },
          },
          logicalLocations: [
            {
              name: "path:vault/.obsidian/plugin-installation.json#/profile_digest",
            },
          ],
        },
      ],
    },
  ]);
});

test("a failed check omits its results only when no step began", () => {
  const before = onlyRun({ kind: "failed", started: false, message: "lock" });
  assert.equal("results" in before, false);
  assert.equal(before.invocations[0]?.executionSuccessful, false);
  const during = onlyRun({ kind: "failed", started: true, message: "EACCES" });
  assert.deepEqual(during.results, []);
});

test("a folder ends with a slash, and the root is written ./", () => {
  const plugin = folderStep("plugin/files", join(root, "plugins", "sample"));
  assert.equal(logicalName(plugin, root), "path:plugins/sample/");
  assert.equal(artifactUri(plugin, root), "plugins/sample/");
  assert.equal(logicalName(folderStep("plugin/files", root), root), "path:./");
});

test("the resource escapes # and %, and the URI encodes each segment", () => {
  const step = fileStep("plugin/mutable-json", join(root, "a#b%c d:e@f.json"));
  assert.equal(logicalName(step, root), "path:a%23b%25c d:e@f.json");
  assert.equal(artifactUri(step, root), "a%23b%25c%20d%3Ae@f.json");
});

test("a path outside the root is rejected", () => {
  assert.equal(pathWithin(root, "/elsewhere/vault"), undefined);
  assert.equal(pathWithin(root, join(root, "..vault")), "..vault");
  assert.throws(
    () => logicalName(fileStep("receipt/absent", "/elsewhere/r.json"), root),
    /outside the root/,
  );
});
