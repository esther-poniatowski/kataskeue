import type { SettingsAdapter } from "../../ports.js";
import { EkphrasisSettingsAdapter } from "./ekphrasisSettingsAdapter.js";
import { FullCalendarRemasteredSettingsAdapter } from "./fullCalendarRemasteredSettingsAdapter.js";

/** Returns the versioned settings adapters shipped by the command-line interface. */
export function createSettingsAdapters(): Readonly<
  Record<string, SettingsAdapter>
> {
  return {
    "ekphrasis@1": new EkphrasisSettingsAdapter(),
    "full-calendar-remastered@0.13.7":
      new FullCalendarRemasteredSettingsAdapter(),
  };
}
