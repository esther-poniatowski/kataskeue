export { applyProfile, checkProfile } from "./application/materializer.js";
export type {
  ApplyOptions,
  CheckOptions,
  MaterializerDependencies,
} from "./application/materializer.js";
export {
  installationReceiptSchema,
  parseInstallationReceipt,
} from "./application/receipt.js";
export type { InstallationReceipt } from "./application/receipt.js";
export { parseLocalOverrides, parseProfile } from "./domain/profile.js";
export { parseLocalSettingsSources } from "./domain/localSettingsSources.js";
export type {
  LocalSettingsSource,
  LocalSettingsSources,
} from "./domain/localSettingsSources.js";
export type {
  LocalOverride,
  LocalOverrides,
  PluginProfile,
  PluginRecord,
} from "./domain/profile.js";
export {
  BundleFetchError,
  BundleNotFoundError,
  DigestMismatchError,
  DriftError,
  OperationLockedError,
  ProfileError,
  ProviderUnsupportedError,
  ReplacementError,
} from "./errors.js";
export type {
  BundleAcquisition,
  BundleProvider,
  OverrideInspector,
  PluginInstaller,
  SettingsAdapter,
  SettingsProjectionContext,
} from "./ports.js";
export { EkphrasisSettingsAdapter } from "./infrastructure/settings/ekphrasisSettingsAdapter.js";
export { FullCalendarRemasteredSettingsAdapter } from "./infrastructure/settings/fullCalendarRemasteredSettingsAdapter.js";
export { SieveSettingsAdapter } from "./infrastructure/settings/sieveSettingsAdapter.js";
export { createSettingsAdapters } from "./infrastructure/settings/settingsAdapters.js";
