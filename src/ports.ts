import type { PluginRecord } from "./domain/profile.js";

export interface BundleAcquisition {
  readonly directory: string;
  readonly source: "release" | "artifact";
  readonly artifact?: {
    readonly locator: string;
    readonly source_commit: string;
    readonly sha256: string;
  };
}

/** Obtains one immutable bundle without mutating a vault. */
export interface BundleProvider {
  obtain(plugin: PluginRecord, destination: string): Promise<BundleAcquisition>;
}

export interface InstallablePlugin {
  readonly path: string;
  readonly enabled: boolean;
}

/** Delegates selected bundle installation to obsidian-launcher. */
export interface PluginInstaller {
  install(vault: string, plugins: readonly InstallablePlugin[]): Promise<void>;
}

/** Generates a complete native settings file from a project-owned source. */
export interface SettingsAdapter {
  project(source: string, destination: string): Promise<void>;
}

export interface OverrideState {
  readonly commit: string | null;
  readonly dirty: boolean | null;
}

/** Reports the source state behind one active local override. */
export interface OverrideInspector {
  inspect(path: string): Promise<OverrideState>;
}

export interface ReplaceOperations {
  move(source: string, destination: string): Promise<void>;
}
