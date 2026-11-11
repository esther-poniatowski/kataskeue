# Settings adapters

The settings adapters generate complete native plugin settings from portable YAML sources. A profile selects an adapter through `settings.adapter`. The canonical source of an adapter has one of two places:

- the adapter of a tool of the workspace reads the settings file of that tool, at `config/tools/<tool>.yml` or `<tool>.yml` below the root, and the profile names no `settings.source`;
- any other adapter reads the YAML source named by `settings.source`.

The [command-line conventions](https://github.com/esther-poniatowski/keystone/blob/main/docs/internals/cli-conventions.md) of the workspace fix the place of a tool settings file. When files exist at both places, the materializer stops with an error that names both. A profile that names `settings.source` for such an adapter is invalid.

The local-settings flag `--local-settings` may select a complete local source. The local record maps a plugin identifier to one source path. The adapter reads either that source or the canonical source. Both paths resolve from the root of the consumer repository. Delivery mode rejects every active local source.

Each source declares its format in the key `_schema`, as its first key, and the [file formats](architecture.md#file-formats) state what the adapter does with it. The adapter reads this key and does not copy it into the native `data.json`.

During `check`, each adapter regenerates its expected native file. Therefore, the check detects changes in inputs read beside the source file.

## Ekphrasis

The adapter identifier `ekphrasis@1` reads the settings file of Ekphrasis, `config/tools/ekphrasis.yml` or `ekphrasis.yml` at the root. It accepts the source below:

```yaml
_schema: ekphrasis:configuration@1
schema_registry: specs/schema-registry.yml
path_rules:
  - pattern: projects/**/project.yml
    schema: utils/schemas/project.schema.yaml
commit_delay: 1000
```

The registry path and each rule path are relative to the root, wherever the file lies. Absolute paths, parent traversal and backslashes are invalid. The commit delay is a nonnegative integer measured in milliseconds. The adapter writes the native keys `schemaRegistry`, `pathRules` and `commitDelay`. The plugin resolves these native paths inside the vault, so the adapter prefixes each path with the folder of the root inside the vault. A root outside the vault is an error.

## Full Calendar Remastered

The adapter identifier `full-calendar-remastered@0.13.7` accepts the source below:

```yaml
_schema: full-calendar:configuration@1
calendar_source:
  id: tasks_1
  name: Obsidian Tasks
  color: "#3b82f6"
interface:
  first_day: 1
  time_format_24h: true
  weather_hidden: true
  display_timezone: Europe/Paris
tasks:
  backlog_date_target: scheduledDate
  calendar_display_date_target: scheduledDate
  open_edit_modal_after_backlog_drop: false
  task_display_format: dayPlanner
  include_global_query_in_backlog: true
  backlog_query: ""
```

The calendar identifier and name are nonempty strings. Its colour is a number sign followed by six hexadecimal digits. Each date target is one of `scheduledDate`, `startDate` and `dueDate`. The task display format is `standard` or `dayPlanner`. The first day is an integer from zero for Sunday through six for Saturday. The display time zone is an Internet Assigned Numbers Authority time-zone identifier.

The adapter writes the complete settings file for plugin release 0.13.7. External accounts, access tokens, the local server, ActivityWatch and the agent remain disabled. The output contains no credential.

## Sieve

The adapter identifier `sieve@1.0.2` accepts this source shape:

```yaml
_schema: sieve:configuration@1
projects_root: projects
specification_file: project.yml
selected_project_ids:
  - project-alpha
  - project-beta
```

The projects root is relative to the consumer vault root. The adapter treats each immediate child containing the declared project file as an integrated project. The adapter reads its stable identifier from the field `identity.id`. Source identifiers must be unique and sorted. Every selected identifier must occur exactly once in the inventory.

The adapter writes one root-anchored exclusion rule for each unselected project directory. The adapter leaves files and directories without the declared project file indexed. Three values must contain portable literal paths:

- the projects root;
- the project filename;
- each discovered project directory name.

These paths admit lowercase alphanumeric characters, dots, underscores and hyphens. The projects root also admits forward slashes between its components. Absolute paths, parent components, backslashes and glob syntax are invalid.

The adapter sets the field `schemaVersion` to 1 and writes an empty display name. Therefore, Sieve retains the vault's default name. The adapter writes no rule when the source selects every integrated project.
