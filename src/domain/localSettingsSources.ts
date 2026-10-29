import * as z from "zod";

import { ProfileError } from "../errors.js";
import {
  pluginIdSchema,
  relativePathSchema,
  type PluginProfile,
} from "./profile.js";

const localSettingsSourceSchema = z
  .object({ source: relativePathSchema })
  .strict();
const localSettingsSourcesSchema = z.record(
  pluginIdSchema,
  localSettingsSourceSchema,
);

export type LocalSettingsSource = Readonly<
  z.infer<typeof localSettingsSourceSchema>
>;
export type LocalSettingsSources = Readonly<
  Record<string, LocalSettingsSource>
>;

/** Parse complete local replacements for losslessly projected settings sources. */
export function parseLocalSettingsSources(
  value: unknown,
  profile: PluginProfile,
): LocalSettingsSources {
  const result = localSettingsSourcesSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new ProfileError(`invalid local settings sources: ${details}`);
  }

  const plugins = new Map(profile.plugins.map((plugin) => [plugin.id, plugin]));
  for (const id of Object.keys(result.data)) {
    const plugin = plugins.get(id);
    if (plugin === undefined) {
      throw new ProfileError(
        `local settings source ${id} is absent from the canonical profile`,
      );
    }
    if (plugin.settings.policy !== "losslessly-projected") {
      throw new ProfileError(
        `local settings source ${id} requires losslessly-projected settings`,
      );
    }
  }
  return result.data;
}
