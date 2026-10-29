# Kataskeue

Kataskeue reads one canonical profile. The materializer makes the community-plugin state of an Obsidian vault match that profile.

## Overview

The canonical file `obsidian-plugins.yml` selects exact plugin bundles, enabled identifiers, and settings policies. First, `apply` prepares a complete candidate. The command verifies every canonical bundle before changing the vault. A local override remains noncanonical, so `apply` records its bytes and Git state instead. Subsequently, `check` compares the current state with the profile. The same command checks the receipt written by `apply`.

The contract covers community plugins. All other Obsidian resources remain outside the contract. The [materializer boundary](docs/adr/materializer-boundary.md) defines this scope.

## Prerequisites

The source checkout requires Node.js 22.14 or a newer release. The checkout also requires pnpm 12.16.1. Install and build the checkout with the following commands:

```sh
pnpm install --frozen-lockfile
pnpm build
```

The examples below call the executable by its installed name. From the source checkout, replace `kataskeue` with `node dist/cli.js`. Before running `apply`, close the target vault in Obsidian.

## Profile

The [generated schema](schemas/obsidian-plugins.schema.json) defines the record structure. The executable parser additionally requires unique, sorted plugin identifiers. This minimal profile selects one required public release:

```yaml
format_version: 1
runtime:
  minimum_obsidian: 1.0.0
  checked_obsidian: 1.14.5
  checked_installer: 1.14.5
plugins:
  - id: sample-plugin
    repository: https://github.com/example/sample-plugin
    requirement: required
    enabled: true
    bundle:
      kind: release
      tag: 1.0.0
    files:
      manifest.json: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      main.js: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    settings:
      policy: machine-local
```

Replace the example values with 64-character lowercase hexadecimal digests. Compute each digest with the 256-bit Secure Hash Algorithm. Plugin identifiers must be unique and sorted. An optional plugin must remain disabled.

Three fields identify the Obsidian releases checked against the profile:

| Field               | Meaning                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `minimum_obsidian`  | profile requires this Obsidian application release or a newer release |
| `checked_obsidian`  | maintainers tested the profile with this Obsidian application release |
| `checked_installer` | maintainers tested the profile with this Obsidian installer release   |

The receipt repeats these values. The materializer does not inspect the Obsidian runtime installed on the target machine.

Each plugin selects one settings policy:

| Policy                 | Materializer behavior                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `native-portable`      | preserves the existing native `data.json`; the consumer tracks that file                                   |
| `machine-local`        | preserves the existing native `data.json`; the consumer leaves that file untracked                         |
| `project-owned`        | requires a declared project file and removes native `data.json`                                            |
| `losslessly-projected` | generates native `data.json` through a named adapter; the CLI supplies the supported adapters listed below |

A plugin may also declare root-level `mutable_json_files`. A declared file may be absent. When present, its path must have a lowercase JSON filename, and its content must remain valid JSON. Names must be unique, sorted and distinct from the bundle files, the settings file and the development marker. Other mutable file types and directories are unsupported, and undeclared entries fail reconciliation.

The command-line interface supplies three settings adapters:

| Adapter                           | Source contract                                                   |
| --------------------------------- | ----------------------------------------------------------------- |
| `ekphrasis@1`                     | portable schema-registry path, path rules and commit delay        |
| `full-calendar-remastered@0.13.7` | Tasks calendar, Tasks integration and portable interface choices  |
| `sieve@1.0.2`                     | project inventory structure and selected stable project identifiers |

The [settings-adapter guide](docs/settings-adapters.md) defines the required keys and admitted values of these source files.

## Commands

The `apply` command builds and verifies a candidate before it changes the target vault:

```sh
kataskeue apply --vault PATH --record PATH/obsidian-plugins.yml
```

The `check` command compares the current native state with the canonical profile and installation receipt:

```sh
kataskeue check --vault PATH --record PATH/obsidian-plugins.yml
```

An untracked override file may select a local build. The selected plugin must also occur in the profile.

```yaml
sample-plugin:
  path: ../../plugins/sample-plugin
```

Relative override paths resolve from the directory containing the canonical record. The `source` paths used by `project-owned` and `losslessly-projected` settings follow the same rule.

```sh
kataskeue apply \
  --vault PATH \
  --record PATH/obsidian-plugins.yml \
  --local-override PATH/obsidian-plugins.local.yml
```

Pass the same override to `check` when checking the local build. The delivery flag `--delivery` rejects every local override.

An untracked local-settings record may replace a complete projected settings source for one plugin. The following record selects a local Sieve source:

```yaml
sieve:
  source: config/obsidian/sieve.local.yml
```

Local settings paths use the canonical record directory as their root. Source paths use the same root. The following command selects the local record:

```sh
kataskeue apply \
  --vault PATH \
  --record PATH/obsidian-plugins.yml \
  --local-settings PATH/obsidian-plugin-settings.local.yml
```

Pass the same local-settings record to `check`. The materializer reads exactly one source. A local source replaces the canonical source in full. The delivery flag `--delivery` rejects local builds and local settings sources.

Each command holds `.kataskeue.lock` for the complete check or change. A normal exit removes the lock. After an abnormal process exit, confirm that no materializer command is running before removing this file manually.

## Source support

Remote releases and retained artifacts enter through a provider. Local builds enter through the separate override record. The available routes have the following status:

| Source                | Current route                                                 |
| --------------------- | ------------------------------------------------------------- |
| public GitHub release | built-in provider through `obsidian-launcher`                 |
| private release       | provider interface; authenticated implementation pending      |
| retained artifact     | provider interface; immutable artifact implementation pending |
| local build           | untracked override mapped to a declared plugin identifier     |

## Documentation

The following notes define the package boundary and its implementation route:

- [Architecture](docs/architecture.md): shows how the modules cooperate to materialize a profile
- [Accepted boundaries](docs/adr/_index.md): delimits the package and its launcher dependency

## License

Read the [license terms](LICENSE).
