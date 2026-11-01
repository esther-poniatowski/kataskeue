#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
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
import { createSettingsAdapters } from "./infrastructure/settings/settingsAdapters.js";
import { pathWithin, sarifLog } from "./infrastructure/sarifLog.js";

const USAGE =
  "usage: kataskeue <apply|check> --vault PATH --record PATH [--format text|sarif] [--output PATH] [--root PATH]";

interface Inputs {
  readonly vault: string;
  readonly root: string;
  readonly profile: ReturnType<typeof parseProfile>;
  readonly localOverrides: LocalOverrides;
  readonly localSettingsSources: LocalSettingsSources;
  readonly delivery: boolean;
}

interface InputPaths {
  readonly vault: string;
  readonly record: string;
  readonly localOverride: string | undefined;
  readonly localSettings: string | undefined;
  readonly delivery: boolean;
}

async function readInputs(paths: InputPaths): Promise<Inputs> {
  const profile = parseProfile(parseYaml(await readFile(paths.record, "utf8")));
  let localOverrides: LocalOverrides = {};
  if (paths.localOverride !== undefined) {
    localOverrides = parseLocalOverrides(
      parseYaml(await readFile(paths.localOverride, "utf8")),
      profile,
    );
  }
  let localSettingsSources: LocalSettingsSources = {};
  if (paths.localSettings !== undefined) {
    localSettingsSources = parseLocalSettingsSources(
      parseYaml(await readFile(paths.localSettings, "utf8")),
      profile,
    );
  }
  return {
    vault: paths.vault,
    root: dirname(resolve(paths.record)),
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

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...commandArguments] = argv;
  if (command !== "apply" && command !== "check") {
    throw new Error(USAGE);
  }
  const { values } = parseArgs({
    args: commandArguments,
    options: {
      vault: { type: "string" },
      record: { type: "string" },
      "local-override": { type: "string" },
      "local-settings": { type: "string" },
      delivery: { type: "boolean", default: false },
      format: { type: "string", default: "text" },
      output: { type: "string" },
      root: { type: "string" },
    },
    strict: true,
  });
  if (values.vault === undefined || values.record === undefined) {
    throw new Error("the --vault and --record options are required");
  }
  if (values.format !== "text" && values.format !== "sarif") {
    throw new Error(`unknown format ${values.format}; ${USAGE}`);
  }
  if (values.format === "sarif" && command !== "check") {
    throw new Error("only check writes a findings log");
  }
  if (
    values.format === "text" &&
    (values.output !== undefined || values.root !== undefined)
  ) {
    throw new Error("the --output and --root options require --format sarif");
  }
  const paths: InputPaths = {
    vault: values.vault,
    record: values.record,
    localOverride: values["local-override"],
    localSettings: values["local-settings"],
    delivery: values.delivery,
  };
  const settingsAdapters = createSettingsAdapters();

  if (command === "check") {
    const cursor = new CheckCursor();
    const sarifRoot = resolve(values.root ?? ".");
    const check = async () => {
      if (
        values.format === "sarif" &&
        pathWithin(sarifRoot, resolve(paths.vault)) === undefined
      ) {
        throw new Error(`the vault lies outside the root ${sarifRoot}`);
      }
      const inputs = await readInputs(paths);
      await checkProfile(inputs, {
        overrideInspector: new GitOverrideInspector(),
        settingsAdapters,
        cursor,
      });
    };
    if (values.format === "text") {
      await check();
      process.stdout.write("plugin profile matches the canonical record\n");
      return;
    }
    const outcome = await observeCheck(check, cursor);
    const log = `${JSON.stringify(
      sarifLog(outcome, { root: sarifRoot, version: packageVersion() }),
      null,
      2,
    )}\n`;
    if (values.output === undefined) {
      process.stdout.write(log);
    } else {
      await mkdir(dirname(resolve(values.output)), { recursive: true });
      await writeFile(values.output, log);
    }
    if (outcome.kind !== "complete") {
      process.exitCode = 1;
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

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
