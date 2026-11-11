#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import ObsidianLauncher from "obsidian-launcher";
import { parse as parseYaml } from "yaml";

import { applyProfile, checkProfile } from "./application/materializer.js";
import { CheckCursor, observeCheck } from "./application/checkSteps.js";
import {
  parseLocalOverrides,
  parseProfile,
  type LocalOverrides,
} from "./domain/profile.js";
import {
  parseLocalSettingsSources,
  type LocalSettingsSources,
} from "./domain/localSettingsSources.js";
import { LauncherBundleProvider } from "./infrastructure/launcherBundleProvider.js";
import { GitOverrideInspector } from "./infrastructure/gitOverrideInspector.js";
import { ObsidianLauncherInstaller } from "./infrastructure/obsidianLauncherInstaller.js";
import { FileFormatError, ProfileError } from "./errors.js";
import { createSettingsAdapters } from "./infrastructure/settings/settingsAdapters.js";
import { pathWithin, sarifLog } from "./infrastructure/sarifLog.js";

const USAGE =
  "usage: kataskeue <apply|check> [-r ROOT] [--vault PATH] [--record PATH] [--local-override PATH] [--local-settings PATH] [--delivery] [--format text|sarif] [-o PATH]\n       kataskeue -v|--version";

/** Name of the canonical record at the root, read when `--record` is absent. */
const RECORD_FILE = "obsidian-plugins.yml";

/** A wrong invocation or an unusable input file: exit status 2. */
class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Exit statuses of the command-line conventions of the workspace. */
const EXIT = { problem: 1, usage: 2 } as const;

interface Inputs {
  readonly vault: string;
  readonly root: string;
  readonly profile: ReturnType<typeof parseProfile>;
  readonly localOverrides: LocalOverrides;
  readonly localSettingsSources: LocalSettingsSources;
  readonly delivery: boolean;
}

interface InputPaths {
  readonly root: string;
  readonly vault: string;
  readonly record: string;
  readonly localOverride: string | undefined;
  readonly localSettings: string | undefined;
  readonly delivery: boolean;
}

/** Read one input file named on the command line or found at the root. */
async function readInputFile(path: string, label: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError(`${label} is missing: ${path}`);
    }
    throw error;
  }
  return parseYaml(contents);
}

async function readInputs(paths: InputPaths): Promise<Inputs> {
  const profile = parseProfile(
    await readInputFile(paths.record, "the canonical record"),
  );
  let localOverrides: LocalOverrides = {};
  if (paths.localOverride !== undefined) {
    localOverrides = parseLocalOverrides(
      await readInputFile(paths.localOverride, "the local-override record"),
      profile,
    );
  }
  let localSettingsSources: LocalSettingsSources = {};
  if (paths.localSettings !== undefined) {
    localSettingsSources = parseLocalSettingsSources(
      await readInputFile(paths.localSettings, "the local-settings record"),
      profile,
    );
  }
  return {
    vault: paths.vault,
    root: paths.root,
    profile,
    localOverrides,
    localSettingsSources,
    delivery: paths.delivery,
  };
}

/** Return the version of the package, the version of the driver in a findings log. */
function packageVersion(): string {
  const manifest = createRequire(import.meta.url)("../package.json") as {
    version: string;
  };
  return manifest.version;
}

/**
 * Resolve the root of the consumer repository.
 *
 * The option `--root` comes first, then the variable `KATASKEUE_ROOT`, then the current
 * folder. Kataskeue has no configuration file of its own, so it searches no ancestor.
 */
function resolveRoot(option: string | undefined): string {
  const variable = process.env.KATASKEUE_ROOT;
  return resolve(option ?? (variable === "" ? undefined : variable) ?? ".");
}

function parseCommand(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        root: { type: "string", short: "r" },
        vault: { type: "string" },
        record: { type: "string" },
        "local-override": { type: "string" },
        "local-settings": { type: "string" },
        delivery: { type: "boolean", default: false },
        format: { type: "string", default: "text" },
        output: { type: "string", short: "o" },
        version: { type: "boolean", short: "v", default: false },
      },
      strict: true,
    });
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseCommand(argv);
  if (values.version) {
    process.stdout.write(`kataskeue ${packageVersion()}\n`);
    return;
  }
  const [command, ...extra] = positionals;
  if ((command !== "apply" && command !== "check") || extra.length > 0) {
    throw new UsageError(USAGE);
  }
  if (values.format !== "text" && values.format !== "sarif") {
    throw new UsageError(`unknown format ${values.format}\n${USAGE}`);
  }
  if (values.format === "sarif" && command !== "check") {
    throw new UsageError("only check writes a findings log");
  }
  if (values.format === "text" && values.output !== undefined) {
    throw new UsageError("the --output option requires --format sarif");
  }
  const root = resolveRoot(values.root);
  const paths: InputPaths = {
    root,
    vault: resolve(values.vault ?? root),
    record: resolve(values.record ?? join(root, RECORD_FILE)),
    localOverride: values["local-override"],
    localSettings: values["local-settings"],
    delivery: values.delivery,
  };
  const settingsAdapters = createSettingsAdapters();

  if (command === "check") {
    const cursor = new CheckCursor();
    let failure: unknown;
    const check = async () => {
      try {
        if (
          values.format === "sarif" &&
          pathWithin(root, paths.vault) === undefined
        ) {
          throw new UsageError(`the vault lies outside the root ${root}`);
        }
        const inputs = await readInputs(paths);
        await checkProfile(inputs, {
          overrideInspector: new GitOverrideInspector(),
          settingsAdapters,
          cursor,
        });
      } catch (error) {
        failure = error;
        throw error;
      }
    };
    if (values.format === "text") {
      await check();
      process.stdout.write("plugin profile matches the canonical record\n");
      return;
    }
    const outcome = await observeCheck(check, cursor);
    const log = `${JSON.stringify(
      sarifLog(outcome, { root, version: packageVersion() }),
      null,
      2,
    )}\n`;
    if (values.output === undefined) {
      process.stdout.write(log);
    } else {
      await mkdir(dirname(resolve(values.output)), { recursive: true });
      await writeFile(values.output, log);
    }
    if (outcome.kind === "drift") {
      process.exitCode = EXIT.problem;
    } else if (outcome.kind === "failed") {
      process.exitCode = exitStatus(failure);
    }
    return;
  }

  const inputs = await readInputs(paths);
  const launcher = new ObsidianLauncher();
  await applyProfile(inputs, {
    bundles: new LauncherBundleProvider(launcher),
    installer: new ObsidianLauncherInstaller(launcher),
    overrideInspector: new GitOverrideInspector(),
    settingsAdapters,
  });
  process.stdout.write("plugin profile materialized and verified\n");
}

/**
 * Return the exit status of an error: 2 for a wrong invocation or an invalid input, 1 for a
 * drift found by the check or a failure of the command.
 */
function exitStatus(error: unknown): number {
  if (
    error instanceof UsageError ||
    error instanceof ProfileError ||
    error instanceof FileFormatError
  ) {
    return EXIT.usage;
  }
  return EXIT.problem;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = exitStatus(error);
});
