# Settings adapters

The settings adapters generate complete native plugin settings from portable YAML sources. A profile selects an adapter through `settings.adapter` and names its YAML source through `settings.source`.

The local-settings flag `--local-settings` may select a complete local source. The local record maps a plugin identifier to one source path. The adapter reads either that source or the canonical source. Both paths resolve from the directory containing the canonical profile. Delivery mode rejects every active local source.

During `check`, each adapter regenerates its expected native file. Therefore, the check detects changes in inputs read beside the source file.

## Ekphrasis

The adapter identifier `ekphrasis@1` accepts the source below:

```yaml
format_version: 1
schema_registry: specs/schema-registry.yml
path_rules:
  - pattern: projects/**/project.yml
    schema: utils/schemas/project.schema.yaml
commit_delay: 1000
```

The registry path and each rule path must remain relative to the vault root. Absolute paths, parent traversal and backslashes are invalid. The commit delay is a nonnegative integer measured in milliseconds. The adapter writes the native keys `schemaRegistry`, `pathRules` and `commitDelay`.

## Full Calendar Remastered

The adapter identifier `full-calendar-remastered@0.13.7` accepts the source below:

```yaml
format_version: 1
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
format_version: 1
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
