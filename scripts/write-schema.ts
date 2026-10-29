import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as z from "zod";

import { pluginProfileSchema } from "../src/domain/profile.js";

const target = resolve("schemas/obsidian-plugins.schema.json");
const schema = z.toJSONSchema(pluginProfileSchema, {
  target: "draft-2020-12",
  io: "input",
});
const plugins = schema.properties?.plugins;
if (plugins !== undefined && typeof plugins === "object") {
  Object.assign(plugins, {
    description:
      "Plugin identifiers must be unique and sorted. The executable parser enforces these cross-entry constraints.",
    "x-executable-constraints": [
      "unique-plugin-identifiers",
      "identifier-order",
    ],
  });
}
const output = `${JSON.stringify(
  {
    $id: "https://github.com/esther-poniatowski/kataskeue/schemas/obsidian-plugins.schema.json",
    title: "Obsidian plugin profile",
    ...schema,
  },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8");
  if (current !== output) {
    process.stderr.write("schemas/obsidian-plugins.schema.json is stale\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(target, output);
}
