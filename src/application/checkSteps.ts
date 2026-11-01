import { DigestMismatchError, DriftError, ProfileError } from "../errors.js";

/**
 * Rules of the check, each with the drift it detects.
 *
 * A finding about one plugin is located at the plugin folder of the vault, or at
 * a file of that folder, so its location does not depend on the position of the
 * plugin in the profile or in the receipt.
 */
export const CHECK_RULES = {
  "receipt/absent": "the vault holds no installation receipt",
  "receipt/invalid": "the installation receipt is not a valid receipt",
  "receipt/profile": "the receipt belongs to another canonical profile",
  "receipt/runtime": "the receipt records another Obsidian runtime",
  "receipt/omissions": "the receipt omits a plugin that may not be omitted",
  "receipt/membership": "the receipt lists other plugins than the profile",
  "plugins/directories":
    "the plugin folders of the vault differ from the expected plugins",
  "plugins/enabled":
    "community-plugins.json differs from the canonical enabled set",
  "plugin/source":
    "the receipt records another source for the plugin than the profile",
  "plugin/files": "the runtime files of the plugin differ from the receipt",
  "plugin/digest":
    "a runtime file of the plugin differs from its declared digest",
  "plugin/undeclared-files": "the plugin folder holds an undeclared file",
  "plugin/mutable-json":
    "a declared mutable file of the plugin is not a regular JSON file",
  "override/active":
    "a local override is installed, but none is declared for the plugin",
  "override/state":
    "the receipt records another local override than the declared one",
  "override/source": "the Git state of the local override source has changed",
  "override/manifest":
    "the manifest of the local override names another plugin",
  "override/files":
    "the files of the local override differ from the installed bytes",
  "settings/source":
    "the declared settings source or adapter of the plugin is unusable",
  "settings/native":
    "project-owned settings left a native data.json in the plugin folder",
  "settings/projected":
    "the native settings differ from the projection of their source",
  "settings/receipt":
    "the receipt records settings for a plugin whose policy records none",
} as const;

export type CheckRuleId = keyof typeof CHECK_RULES;

/** One step of the check: the rule it applies and the place it inspects. */
export interface CheckStep {
  readonly rule: CheckRuleId;
  /** Absolute path of the inspected file or folder. */
  readonly path: string;
  readonly folder: boolean;
  /** JSON Pointer into the inspected file; empty for the whole file or folder. */
  readonly locus: string;
}

/** Return the step of `rule` on the file `path`, at `locus` within the file. */
export function fileStep(
  rule: CheckRuleId,
  path: string,
  locus = "",
): CheckStep {
  return { rule, path, folder: false, locus };
}

/** Return the step of `rule` on the folder `path`. */
export function folderStep(rule: CheckRuleId, path: string): CheckStep {
  return { rule, path, folder: true, locus: "" };
}

/**
 * Record the step of the check in progress.
 *
 * The check stops at its first failure. A step that fails leaves itself current,
 * so the caller can locate the failure; a step that passes clears it.
 */
export class CheckCursor {
  #current: CheckStep | undefined;
  #started = false;

  /** The step that failed, or `undefined` when no step is in progress. */
  get current(): CheckStep | undefined {
    return this.#current;
  }

  /** Whether the check entered its first step. */
  get started(): boolean {
    return this.#started;
  }

  async within<T>(step: CheckStep, run: () => T | Promise<T>): Promise<T> {
    this.#started = true;
    this.#current = step;
    const value = await run();
    this.#current = undefined;
    return value;
  }
}

/** Outcome of one check: complete, stopped at a drift, or failed. */
export type CheckOutcome =
  | { readonly kind: "complete" }
  | {
      readonly kind: "drift";
      readonly step: CheckStep;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      /** Whether the check entered its first step before it failed. */
      readonly started: boolean;
      readonly message: string;
    };

/**
 * Run `check` and classify how it ended.
 *
 * A drift, a digest mismatch or a profile error raised inside a step concerns
 * the place that the step inspects. Any other error, such as a denied read or a
 * held lock, and any error outside a step, is a failure of the check itself.
 */
export async function observeCheck(
  check: () => Promise<unknown>,
  cursor: CheckCursor,
): Promise<CheckOutcome> {
  try {
    await check();
    return { kind: "complete" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const located =
      error instanceof DriftError ||
      error instanceof DigestMismatchError ||
      error instanceof ProfileError;
    const step = cursor.current;
    if (located && step !== undefined) {
      return { kind: "drift", step, message };
    }
    return { kind: "failed", started: cursor.started, message };
  }
}
