# Settings adapters

The settings adapters generate complete native plugin settings from portable YAML sources. A profile selects an adapter through `settings.adapter` and names its YAML source through `settings.source`.

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
