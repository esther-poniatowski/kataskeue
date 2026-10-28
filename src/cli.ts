#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import ObsidianLauncher from "obsidian-launcher";
import { parse as parseYaml } from "yaml";

import { applyProfile, checkProfile } from "./application/materializer.js";
import {
  parseLocalOverrides,
  parseProfile,
  type LocalOverrides,
} from "./domain/profile.js";
import { LauncherBundleProvider } from "./infrastructure/launcherBundleProvider.js";
import { GitOverrideInspector } from "./infrastructure/gitOverrideInspector.js";
import { ObsidianLauncherInstaller } from "./infrastructure/obsidianLauncherInstaller.js";
import { createSettingsAdapters } from "./infrastructure/settings/settingsAdapters.js";

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...commandArguments] = argv;
  if (command !== "apply" && command !== "check") {
    throw new Error(
      "usage: obsidian-plugin-materializer <apply|check> --vault PATH --record PATH",
    );
  }
  const { values } = parseArgs({
    args: commandArguments,
    options: {
      vault: { type: "string" },
      record: { type: "string" },
      "local-override": { type: "string" },
      delivery: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.vault === undefined || values.record === undefined) {
    throw new Error("the --vault and --record options are required");
  }
  const profile = parseProfile(
    parseYaml(await readFile(values.record, "utf8")),
  );

  let localOverrides: LocalOverrides = {};
  if (values["local-override"] !== undefined) {
    localOverrides = parseLocalOverrides(
      parseYaml(await readFile(values["local-override"], "utf8")),
      profile,
    );
  }
  const root = dirname(resolve(values.record));

  if (command === "check") {
    await checkProfile(
      { vault: values.vault, root, profile, localOverrides },
      { overrideInspector: new GitOverrideInspector() },
    );
    process.stdout.write("plugin profile matches the canonical record\n");
    return;
  }

  const launcher = new ObsidianLauncher();
  await applyProfile(
    {
      vault: values.vault,
      root,
      profile,
      localOverrides,
      delivery: values.delivery,
    },
    {
      bundles: new LauncherBundleProvider(launcher),
      installer: new ObsidianLauncherInstaller(launcher),
      overrideInspector: new GitOverrideInspector(),
      settingsAdapters: createSettingsAdapters(),
    },
  );
  process.stdout.write("plugin profile materialized and verified\n");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
