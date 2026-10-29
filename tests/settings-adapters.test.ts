import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProfileError } from "../src/errors.js";
import { EkphrasisSettingsAdapter } from "../src/infrastructure/settings/ekphrasisSettingsAdapter.js";
import { FullCalendarRemasteredSettingsAdapter } from "../src/infrastructure/settings/fullCalendarRemasteredSettingsAdapter.js";
import { SieveSettingsAdapter } from "../src/infrastructure/settings/sieveSettingsAdapter.js";

test("projects the complete Ekphrasis native settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ekphrasis-settings-"));
  const source = join(root, "ekphrasis.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "schema_registry: specs/schema-registry.yml",
      "path_rules:",
      "  - pattern: projects/**/project.yml",
      "    schema: utils/schemas/project.schema.yaml",
      "commit_delay: 1000",
      "",
    ].join("\n"),
  );
  await new EkphrasisSettingsAdapter().project(source, destination);
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), {
    schemaRegistry: "specs/schema-registry.yml",
    pathRules: [
      {
        pattern: "projects/**/project.yml",
        schema: "utils/schemas/project.schema.yaml",
      },
    ],
    commitDelay: 1000,
  });
});

test("projects the Full Calendar Tasks workflow without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "full-calendar-settings-"));
  const source = join(root, "full-calendar.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "calendar_source:",
      "  id: tasks_1",
      "  name: Obsidian Tasks",
      '  color: "#3b82f6"',
      "interface:",
      "  first_day: 1",
      "  time_format_24h: true",
      "  weather_hidden: true",
      "  display_timezone: Europe/Paris",
      "tasks:",
      "  backlog_date_target: scheduledDate",
      "  calendar_display_date_target: scheduledDate",
      "  open_edit_modal_after_backlog_drop: false",
      "  task_display_format: dayPlanner",
      "  include_global_query_in_backlog: true",
      '  backlog_query: ""',
      "",
    ].join("\n"),
  );
  const adapter = new FullCalendarRemasteredSettingsAdapter();
  await adapter.project(source, destination);
  const outputText = await readFile(destination, "utf8");
  const output = JSON.parse(outputText) as Record<string, unknown>;
  assert.deepEqual(
    output,
    JSON.parse(
      await readFile(
        join(
          import.meta.dirname,
          "fixtures",
          "full-calendar-remastered-0.13.7.json",
        ),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(output.calendarSources, [
    {
      type: "tasks",
      name: "Obsidian Tasks",
      color: "#3b82f6",
      id: "tasks_1",
    },
  ]);
  assert.deepEqual(output.tasksIntegration, {
    backlogDateTarget: "scheduledDate",
    calendarDisplayDateTarget: "scheduledDate",
    openEditModalAfterBacklogDrop: false,
    taskDisplayFormat: "dayPlanner",
    includeGlobalQueryInBacklog: true,
    backlogQuery: "",
  });
  assert.equal(output.displayTimezone, "Europe/Paris");
  assert.equal(output.lastSystemTimezone, "Europe/Paris");
  assert.deepEqual(output.googleAccounts, []);
  assert.deepEqual(output.microsoftAccounts, []);
  assert.deepEqual(output.apiTokens, {});
  assert.equal(
    (output.agent as { enabled: boolean; apiKey: string }).enabled,
    false,
  );
  assert.equal(
    (output.agent as { enabled: boolean; apiKey: string }).apiKey,
    "",
  );
});

test("rejects a settings adapter assigned to an incompatible plugin bundle", () => {
  const fullCalendar = new FullCalendarRemasteredSettingsAdapter();
  const base = {
    repository: "https://github.com/example/plugin",
    requirement: "required" as const,
    enabled: true,
    files: {
      "manifest.json": "a".repeat(64),
      "main.js": "b".repeat(64),
    },
    settings: { policy: "machine-local" as const },
  };
  assert.equal(
    fullCalendar.supports({
      ...base,
      id: "another-plugin",
      bundle: { kind: "release", tag: "0.13.7" },
    }),
    false,
  );
  assert.equal(
    fullCalendar.supports({
      ...base,
      id: "full-calendar-remastered",
      bundle: { kind: "release", tag: "0.13.8" },
    }),
    false,
  );
});

test("rejects malformed adapter sources and nonportable Ekphrasis paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-settings-"));
  const destination = join(root, "data.json");
  const malformed = join(root, "malformed.yml");
  await writeFile(malformed, "field: [\n");
  await assert.rejects(
    new EkphrasisSettingsAdapter().project(malformed, destination),
    ProfileError,
  );

  const escaping = join(root, "escaping.yml");
  await writeFile(
    escaping,
    [
      "format_version: 1",
      "schema_registry: ../outside.yml",
      "path_rules: []",
      "commit_delay: 1000",
      "",
    ].join("\n"),
  );
  await assert.rejects(
    new EkphrasisSettingsAdapter().project(escaping, destination),
    ProfileError,
  );
});

test("rejects an invalid Full Calendar display time zone", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-time-zone-"));
  const source = join(root, "full-calendar.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "calendar_source:",
      "  id: tasks_1",
      "  name: Obsidian Tasks",
      '  color: "#3b82f6"',
      "interface:",
      "  first_day: 1",
      "  time_format_24h: true",
      "  weather_hidden: true",
      "  display_timezone: Not/AZone",
      "tasks:",
      "  backlog_date_target: scheduledDate",
      "  calendar_display_date_target: scheduledDate",
      "  open_edit_modal_after_backlog_drop: false",
      "  task_display_format: dayPlanner",
      "  include_global_query_in_backlog: true",
      '  backlog_query: ""',
      "",
    ].join("\n"),
  );
  await assert.rejects(
    new FullCalendarRemasteredSettingsAdapter().project(source, destination),
    ProfileError,
  );
});

test("projects exact Sieve rules for unselected project directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "sieve-settings-"));
  await writeProject(root, "selected-directory", "selected-project");
  await writeProject(root, "unselected-directory", "unselected-project");
  await mkdir(join(root, "projects", "_audits"), { recursive: true });
  await writeFile(join(root, "projects", "TODO.md"), "# Tasks\n");
  const source = join(root, "sieve.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "projects_root: projects",
      "specification_file: project.yml",
      "selected_project_ids:",
      "  - selected-project",
      "",
    ].join("\n"),
  );

  await new SieveSettingsAdapter().project(source, destination, {
    consumerRoot: root,
  });
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), {
    schemaVersion: 1,
    rules: "/projects/unselected-directory\n",
    displayName: "",
  });
});

test("projects empty Sieve rules when every project is selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "sieve-settings-"));
  await writeProject(root, "selected-directory", "selected-project");
  const source = join(root, "sieve.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "projects_root: projects",
      "specification_file: project.yml",
      "selected_project_ids:",
      "  - selected-project",
      "",
    ].join("\n"),
  );

  await new SieveSettingsAdapter().project(source, destination, {
    consumerRoot: root,
  });
  assert.equal(
    (JSON.parse(await readFile(destination, "utf8")) as { rules: string })
      .rules,
    "",
  );
});

test("rejects duplicate Sieve project identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-sieve-settings-"));
  await writeProject(root, "first", "duplicate-project");
  await writeProject(root, "second", "duplicate-project");
  const source = join(root, "sieve.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "projects_root: projects",
      "specification_file: project.yml",
      "selected_project_ids:",
      "  - absent-project",
      "",
    ].join("\n"),
  );
  await assert.rejects(
    new SieveSettingsAdapter().project(source, destination, {
      consumerRoot: root,
    }),
    ProfileError,
  );
});

test("rejects a selected identifier absent from the project inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-sieve-settings-"));
  await writeProject(root, "present", "present-project");
  const source = join(root, "sieve.yml");
  const destination = join(root, "data.json");
  await writeFile(
    source,
    [
      "format_version: 1",
      "projects_root: projects",
      "specification_file: project.yml",
      "selected_project_ids:",
      "  - absent-project",
      "",
    ].join("\n"),
  );
  await assert.rejects(
    new SieveSettingsAdapter().project(source, destination, {
      consumerRoot: root,
    }),
    ProfileError,
  );
});

test("rejects duplicate and unsorted selected project identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-sieve-settings-"));
  await writeProject(root, "alpha", "alpha-project");
  await writeProject(root, "beta", "beta-project");
  const source = join(root, "sieve.yml");
  const destination = join(root, "data.json");
  for (const identifiers of [
    ["alpha-project", "alpha-project"],
    ["beta-project", "alpha-project"],
  ]) {
    await writeFile(
      source,
      [
        "format_version: 1",
        "projects_root: projects",
        "specification_file: project.yml",
        "selected_project_ids:",
        ...identifiers.map((id) => `  - ${id}`),
        "",
      ].join("\n"),
    );
    await assert.rejects(
      new SieveSettingsAdapter().project(source, destination, {
        consumerRoot: root,
      }),
      ProfileError,
    );
  }
});

test("rejects unsafe project directories and malformed specifications", async () => {
  for (const [directory, contents] of [
    ["unsafe[project]", "identity:\n  id: unsafe-project\n"],
    ["malformed-project", "scope: {}\n"],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "invalid-sieve-settings-"));
    const project = join(root, "projects", directory);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "project.yml"), contents);
    const source = join(root, "sieve.yml");
    const destination = join(root, "data.json");
    await writeFile(
      source,
      [
        "format_version: 1",
        "projects_root: projects",
        "specification_file: project.yml",
        "selected_project_ids: []",
        "",
      ].join("\n"),
    );
    await assert.rejects(
      new SieveSettingsAdapter().project(source, destination, {
        consumerRoot: root,
      }),
      ProfileError,
    );
  }
});

test("supports only the declared Sieve release", () => {
  const adapter = new SieveSettingsAdapter();
  const base = {
    id: "sieve",
    repository: "https://github.com/example/sieve",
    requirement: "required" as const,
    enabled: true,
    files: {
      "manifest.json": "a".repeat(64),
      "main.js": "b".repeat(64),
    },
    settings: { policy: "machine-local" as const },
  };
  assert.equal(
    adapter.supports({
      ...base,
      bundle: { kind: "release", tag: "1.0.2" },
    }),
    true,
  );
  assert.equal(
    adapter.supports({
      ...base,
      bundle: { kind: "release", tag: "1.0.3" },
    }),
    false,
  );
});

async function writeProject(
  root: string,
  directory: string,
  id: string,
): Promise<void> {
  const project = join(root, "projects", directory);
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "project.yml"), `identity:\n  id: ${id}\n`);
}
