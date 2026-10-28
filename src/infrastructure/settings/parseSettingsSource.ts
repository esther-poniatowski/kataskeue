import { parse as parseYaml } from "yaml";

import { ProfileError } from "../../errors.js";

/** Parse one settings source and convert syntax failures into profile errors. */
export function parseSettingsSource(contents: string, label: string): unknown {
  try {
    return parseYaml(contents);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new ProfileError(`${label} is not valid YAML${detail}`);
  }
}
