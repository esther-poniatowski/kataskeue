import { copyFile, lstat, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

import ObsidianLauncher, { type PluginEntry } from "obsidian-launcher";

import type { InstallablePlugin, PluginInstaller } from "../ports.js";

/** Installs prepared local bundles through the qualified obsidian-launcher API. */
export class ObsidianLauncherInstaller implements PluginInstaller {
  readonly #launcher: {
    installPlugins(vault: string, plugins: PluginEntry[]): Promise<void>;
  };

  constructor(
    launcher: {
      installPlugins(vault: string, plugins: PluginEntry[]): Promise<void>;
    } = new ObsidianLauncher(),
  ) {
    this.#launcher = launcher;
  }

  async install(
    vault: string,
    plugins: readonly InstallablePlugin[],
  ): Promise<void> {
    await this.#launcher.installPlugins(
      vault,
      plugins.map((plugin) => ({ path: plugin.path, enabled: plugin.enabled })),
    );
    await detachLinkedFiles(join(vault, ".obsidian", "plugins"));
  }
}

/**
 * Replaces every hard-linked file of the installed plugins by a private copy.
 *
 * The launcher links bundle files from its shared cache when it can. A later
 * write to an installed file would then change the cached bundle of every vault.
 */
async function detachLinkedFiles(pluginsDirectory: string): Promise<void> {
  let plugins: string[];
  try {
    plugins = await readdir(pluginsDirectory);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  for (const plugin of plugins) {
    const directory = join(pluginsDirectory, plugin);
    if (!(await lstat(directory)).isDirectory()) {
      continue;
    }
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const status = await lstat(path);
      if (!status.isFile() || status.nlink < 2) {
        continue;
      }
      const copy = join(directory, `.${name}.detached`);
      await copyFile(path, copy);
      await rename(copy, path);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
