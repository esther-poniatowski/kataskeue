import {
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import * as z from "zod";

import type { PluginRecord } from "../../domain/profile.js";
import { ProfileError } from "../../errors.js";
import type {
  SettingsAdapter,
  SettingsProjectionContext,
} from "../../ports.js";
import { parseSettingsSource } from "./parseSettingsSource.js";

const portableNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const portablePathSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/);
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const selectedProjectIdsSchema = z
  .array(projectIdSchema)
  .superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "selected project identifiers must be unique",
      });
    }
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    if (ids.some((id, index) => id !== sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "selected project identifiers must follow identifier order",
      });
    }
  });

const sourceSchema = z
  .object({
    format_version: z.literal(1),
    projects_root: portablePathSchema,
    specification_file: portableNameSchema,
    selected_project_ids: selectedProjectIdsSchema,
  })
  .strict();
const projectSpecificationSchema = z
  .object({
    identity: z.object({ id: projectIdSchema }).passthrough(),
  })
  .passthrough();

interface ProjectEntry {
  readonly id: string;
  readonly directory: string;
}

/** Projects stable project selections onto the complete Sieve 1.0.2 settings. */
export class SieveSettingsAdapter implements SettingsAdapter {
  supports(plugin: PluginRecord): boolean {
    return (
      plugin.id === "sieve" &&
      plugin.bundle.kind === "release" &&
      plugin.bundle.tag === "1.0.2"
    );
  }

  async project(
    source: string,
    destination: string,
    context: SettingsProjectionContext,
  ): Promise<void> {
    const parsed = sourceSchema.safeParse(
      parseSettingsSource(
        await readFile(source, "utf8"),
        "Sieve settings source",
      ),
    );
    if (!parsed.success) {
      throw new ProfileError(
        `invalid Sieve settings: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }

    const projectsRoot = await resolveProjectsRoot(
      context.consumerRoot,
      parsed.data.projects_root,
    );
    const projects = await inventoryProjects(
      projectsRoot,
      parsed.data.specification_file,
    );
    const selected = new Set(parsed.data.selected_project_ids);
    const inventory = new Set(projects.map((project) => project.id));
    for (const id of selected) {
      if (!inventory.has(id)) {
        throw new ProfileError(
          `selected project ${id} is absent from the project inventory`,
        );
      }
    }

    const rules = projects
      .filter((project) => !selected.has(project.id))
      .map((project) => `/${parsed.data.projects_root}/${project.directory}`)
      .sort((left, right) => left.localeCompare(right));
    const settings = {
      schemaVersion: 1,
      rules: rules.length === 0 ? "" : `${rules.join("\n")}\n`,
      displayName: "",
    };
    await writeFile(destination, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

async function resolveProjectsRoot(
  consumerRoot: string,
  projectsPath: string,
): Promise<string> {
  const lexicalRoot = resolve(consumerRoot);
  const lexicalProjects = resolve(lexicalRoot, projectsPath);
  if (!isWithin(lexicalRoot, lexicalProjects)) {
    throw new ProfileError(
      `projects root leaves the consumer root: ${projectsPath}`,
    );
  }

  let actualRoot: string;
  let actualProjects: string;
  try {
    [actualRoot, actualProjects] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalProjects),
    ]);
  } catch (error) {
    if (isMissing(error)) {
      throw new ProfileError(`projects root is missing: ${lexicalProjects}`);
    }
    throw error;
  }
  if (!isWithin(actualRoot, actualProjects)) {
    throw new ProfileError("projects root resolves outside the consumer root");
  }
  if (!(await stat(actualProjects)).isDirectory()) {
    throw new ProfileError(
      `projects root is not a directory: ${actualProjects}`,
    );
  }
  return actualProjects;
}

async function inventoryProjects(
  projectsRoot: string,
  specificationFile: string,
): Promise<readonly ProjectEntry[]> {
  const projects: ProjectEntry[] = [];
  const identifiers = new Map<string, string>();
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const specification = resolve(projectsRoot, entry.name, specificationFile);
    const state = await optionalFileState(specification);
    if (state === undefined) continue;
    if (!state.isFile()) {
      throw new ProfileError(
        `project specification is not a regular file: ${specification}`,
      );
    }
    if (!portableNameSchema.safeParse(entry.name).success) {
      throw new ProfileError(
        `project directory is not a portable literal path: ${entry.name}`,
      );
    }
    const parsed = projectSpecificationSchema.safeParse(
      parseSettingsSource(
        await readFile(specification, "utf8"),
        `project specification ${specification}`,
      ),
    );
    if (!parsed.success) {
      throw new ProfileError(
        `invalid project specification ${specification}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const previous = identifiers.get(parsed.data.identity.id);
    if (previous !== undefined) {
      throw new ProfileError(
        `project identifier ${parsed.data.identity.id} is declared by both ${previous} and ${entry.name}`,
      );
    }
    identifiers.set(parsed.data.identity.id, entry.name);
    projects.push({ id: parsed.data.identity.id, directory: entry.name });
  }
  return projects;
}

async function optionalFileState(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return (
    relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
