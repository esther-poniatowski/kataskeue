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
  }
}
