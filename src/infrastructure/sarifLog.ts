import { isAbsolute, relative, sep } from "node:path";

import {
  CHECK_RULES,
  type CheckOutcome,
  type CheckStep,
} from "../application/checkSteps.js";

/**
 * Write the outcome of a check as a log of the findings profile of Elenchos, a
 * subset of SARIF 2.1.0.
 *
 * The log holds one run of the driver `kataskeue`, whose driver lists every rule
 * of the check. The check stops at its first drift, so a run holds at most one
 * result, and a run that found a drift declares itself incomplete: the steps
 * after the drift did not run. A failed run states why it stopped, and omits its
 * results when it failed before its first step. No result holds a region, so a
 * physical location denotes the whole file or folder. The gate builds the
 * identity of each result and writes its suppressions; a producer writes neither.
 */

const SARIF_SCHEMA =
  "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json";
const TOOL_NAME = "kataskeue";
const URI_BASE_ID = "SRCROOT";
/** Every drift fails the check, so every rule and result has level error. */
const LEVEL = "error";
const STOPPED_AT_DRIFT =
  "the check stopped at its first drift; the later steps did not run";

/** Return `path` relative to `root`, or `undefined` when `path` lies outside `root`. */
export function pathWithin(root: string, path: string): string | undefined {
  const inner = relative(root, path);
  const outside =
    inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner);
  return outside ? undefined : inner;
}

/** Return the path of `step` relative to `root`, in POSIX form; a folder ends with `/`. */
export function resourcePath(step: CheckStep, root: string): string {
  const path = pathWithin(root, step.path);
  if (path === undefined) {
    throw new Error(`${step.path} lies outside the root ${root}`);
  }
  const posix = path.split(sep).join("/");
  if (step.folder) {
    return posix === "" ? "./" : `${posix}/`;
  }
  return posix;
}

/**
 * Return `path:<path>`, followed by `#<locus>` when the locus is not empty.
 *
 * In the resource, `%` is written `%25` and `#` is written `%23`, so that the
 * name splits at its first `#`; the locus is written as is.
 */
export function logicalName(step: CheckStep, root: string): string {
  const resource = `path:${resourcePath(step, root)
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")}`;
  return step.locus === "" ? resource : `${resource}#${step.locus}`;
}

/**
 * Return the path of `step` percent-encoded as a relative URI reference.
 *
 * Each segment keeps the unreserved characters, the sub-delimiters and `@`; a
 * colon is encoded, so that a first segment never reads as a scheme.
 */
export function artifactUri(step: CheckStep, root: string): string {
  return resourcePath(step, root)
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/%(24|26|2B|2C|3B|3D|40)/g, (code) =>
        decodeURIComponent(code),
      ),
    )
    .join("/");
}

function result(step: CheckStep, message: string, root: string): object {
  return {
    ruleId: step.rule,
    level: LEVEL,
    message: { text: message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: artifactUri(step, root),
            uriBaseId: URI_BASE_ID,
          },
        },
        logicalLocations: [{ name: logicalName(step, root) }],
      },
    ],
  };
}

function failedInvocation(reason: string): object {
  return {
    executionSuccessful: false,
    toolExecutionNotifications: [{ level: "error", message: { text: reason } }],
  };
}

/** Return the log of one check by Kataskeue of `version`, with paths relative to `root`. */
export function sarifLog(
  outcome: CheckOutcome,
  options: { readonly root: string; readonly version: string },
): object {
  const rules = Object.entries(CHECK_RULES).map(([id, description]) => ({
    id,
    shortDescription: { text: description },
    defaultConfiguration: { level: LEVEL },
  }));
  let run: Record<string, unknown>;
  switch (outcome.kind) {
    case "complete":
      run = { invocations: [{ executionSuccessful: true }], results: [] };
      break;
    case "drift":
      run = {
        invocations: [failedInvocation(STOPPED_AT_DRIFT)],
        results: [result(outcome.step, outcome.message, options.root)],
      };
      break;
    case "failed":
      run = {
        invocations: [failedInvocation(outcome.message)],
        ...(outcome.started ? { results: [] } : {}),
      };
      break;
  }
  return {
    version: "2.1.0",
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: { name: TOOL_NAME, version: options.version, rules },
        },
        ...run,
        columnKind: "utf16CodeUnits",
      },
    ],
  };
}
