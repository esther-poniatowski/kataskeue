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

## Run at a pinned commit

A consumer can run Kataskeue at an exact commit without a checkout. The command below lets npm perform three steps:

1. fetch the commit;
2. build `dist/` through the `prepare` script;
3. run the executable.

```sh
npx --yes npm@12.2.1 exec --yes --allow-git=root \
  --package=github:esther-poniatowski/kataskeue#<commit> \
  -- kataskeue check
```

The command pins npm 12.2.1 for two reasons. npm 10 cannot build a Git package with a `prepare` script during `exec`. npm 12 refuses Git sources by default. The option `--allow-git=root` admits only the named package.

## Profile

The [generated schema](schemas/obsidian-plugins.schema.json) defines the record structure. The executable parser additionally requires unique, sorted plugin identifiers. This minimal profile selects one required public release:

```yaml
_schema: kataskeue:obsidian-plugins@1
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

The first key `_schema` declares the format of the record, and the [file formats](docs/architecture.md#file-formats) state what a reader does with it. Replace the example values with 64-character lowercase hexadecimal digests. Compute each digest with the 256-bit Secure Hash Algorithm. Plugin identifiers must be unique and sorted. An optional plugin must remain disabled.

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

A `losslessly-projected` record names its source through `settings.source`, unless its adapter reads the configuration file of its tool. That file has a fixed place under the [command-line conventions](https://github.com/esther-poniatowski/keystone/blob/main/docs/internals/cli-conventions.md): `config/tools/<tool>.yml` or `<tool>.yml` at the root. The record then names no source, and two files at both places stop the command with an error that names both.

A plugin may also declare root-level `mutable_json_files`. A declared file may be absent. When present, its path must have a lowercase JSON filename, and its content must remain valid JSON. Names must be unique, sorted and distinct from the bundle files, the settings file and the development marker. Other mutable file types and directories are unsupported, and undeclared entries fail reconciliation.

The command-line interface supplies three settings adapters:

| Adapter                           | Source                                          | Source contract                                                     |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| `ekphrasis@1`                     | `config/tools/ekphrasis.yml` or `ekphrasis.yml` | portable schema-registry path, path rules and commit delay          |
| `full-calendar-remastered@0.13.7` | `settings.source`                               | Tasks calendar, Tasks integration and portable interface choices    |
| `sieve@1.0.2`                     | `settings.source`                               | project inventory structure and selected stable project identifiers |

The [settings-adapter guide](docs/settings-adapters.md) defines the required keys and admitted values of these source files.

## Commands

The `apply` command builds and verifies a candidate before it changes the target vault:

```sh
kataskeue apply
```

The `check` command compares the current native state with the canonical profile and installation receipt:

```sh
kataskeue check
```

Both commands work on the root of a consumer repository. The root is the first of three answers:

1. the option `-r`, `--root PATH`;
2. the environment variable `KATASKEUE_ROOT`;
3. the current folder.

Kataskeue has no configuration file of its own, so it searches no ancestor folder. The canonical record is `obsidian-plugins.yml` at the root, and the vault is the root, unless the options `--record PATH` and `--vault PATH` name others. A path given on the command line is relative to the current folder. A path written in the record or in a local record is relative to the root.

`apply` regenerates the managed plugin state of the vault, `.obsidian/plugins/` and `community-plugins.json`, from the record, so it overwrites that state without `--force`. The option `-v`, `--version` prints the version of the tool. The exit status is 0 on success and 1 when `check` finds a drift or a command fails. It is 2 on a usage error or an invalid input: an unknown option, a missing or invalid record, or an unusable settings source.

An untracked override file may select a local build. The selected plugin must also occur in the profile.

```yaml
sample-plugin:
  path: ../../plugins/sample-plugin
```

Relative override paths resolve from the root. The `source` paths used by `project-owned` and `losslessly-projected` settings follow the same rule.

```sh
kataskeue apply --local-override obsidian-plugins.local.yml
```

Pass the same override to `check` when checking the local build. The delivery flag `--delivery` rejects every local override.

An untracked local-settings record may replace a complete projected settings source for one plugin. The following record selects a local Sieve source:

```yaml
sieve:
  source: config/obsidian/sieve.local.yml
```

Local settings paths resolve from the root, as source paths do. The following command selects the local record:

```sh
kataskeue apply --local-settings obsidian-plugin-settings.local.yml
```

Pass the same local-settings record to `check`. The materializer reads exactly one source. A local source replaces the canonical source in full. The delivery flag `--delivery` rejects local builds and local settings sources.

Each command holds `.kataskeue.lock` for the complete check or change. A normal exit removes the lock. After an abnormal process exit, confirm that no materializer command is running before removing this file manually.

## Findings log

The `check` command can write its result as a SARIF 2.1.0 log, in the findings profile of the gate [Elenchos](https://github.com/esther-poniatowski/elenchos):

```sh
kataskeue check --format sarif --output build/kataskeue.sarif
```

The log states every path relative to the root, and the vault must lie under the root. A drift yields one result, located at the file or folder that drifted. The check stops at its first drift, so the run declares itself incomplete. The [findings output](docs/adr/findings-output.md) lists the rules and their locations.

## Recovery from drift

`check` reports drift when an installed runtime file no longer matches its declared digest. Each installed file is a private copy, so the drift stays within the vault. Run `apply` again: it restores the file from the verified bundle.

`apply` refuses to install a bundle that no longer matches its declared digest, and reports:

```text
dataview/main.js digest differs: expected <declared>; found <actual>
```

In that case, the launcher cache holds a damaged copy of the release. Earlier releases of Kataskeue linked installed files into that cache. Therefore, an edit inside a vault could damage the cached copy. To recover, delete the cached release. Then, run `apply` again to download the release afresh:

```sh
rm -rf "${OBSIDIAN_CACHE:-$HOME/.obsidian-cache}/obsidian-plugins/<owner>/<repository>/<tag>"
kataskeue apply
```

A vault materialized before the private copies may still share files with the cache. Run `apply` once to replace them by private copies.

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
