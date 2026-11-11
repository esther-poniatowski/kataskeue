# Architecture

This note assigns each part of the materializer to one module layer. The package turns one canonical profile into verified native state.

| Layer          | Responsibility                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------- |
| domain         | validates profiles, local build overrides and local settings sources; defines accepted records    |
| application    | prepares the declared profile; compares file digests; reconciles installed state; checks receipts |
| ports          | defines bundle, installer, settings and replacement interfaces                                    |
| infrastructure | adapts `obsidian-launcher` and future authenticated or artifact providers; writes findings logs   |

Each plugin adapter belongs to the infrastructure layer. The adapter converts its versioned portable source into a complete native file. Its context supplies the consumer vault root when the adapter must inspect declared repository inputs. The context also supplies the root of the consumer repository, from which a tool settings file resolves its paths.

The application layer receives every external collaborator through a port. Therefore, local inputs suffice to validate and reconcile a profile. Providers contain the network code, and an installer port contains the concrete launcher.

The apply operation proceeds through one ordered route:

1. validate the canonical profile, local build overrides and local settings sources;
2. acquire the vault lock and recover an interrupted change;
3. obtain every selected bundle and verify its declared files;
4. install prepared local bundles into a staging vault;
5. reconcile enabled identifiers, plugin directories, release files, declared mutable JSON files and governed settings;
6. verify the staged state;
7. record the preceding state on disk and replace the managed native state;
8. verify the resulting state, retain its receipt, and delete the recovery record;
9. release the vault lock.

The tool never deletes a stale lock automatically. This constraint prevents two commands from reclaiming the same stale lock and then changing one vault concurrently. After an abnormal process exit, an operator removes the lock only after confirming that no materializer command remains active.

When a provider confirms a missing bundle, it may omit the corresponding disabled optional plugin. An unsupported provider, a failed login, and another fetch failure leave the bundle status unresolved. Such errors reject the candidate. Required plugins must be present. Differing digests and missing settings adapters also reject the candidate before the vault changes.

The canonical profile determines which plugins must exist. A receipt identifies each bundle source and the canonical or local mode of each projected settings source. The receipt also records the installed digests. These fields permit checks of the installed bytes and governed configuration. The receipt cannot remove a required plugin from the expected set.

The check route uses the same authority boundary:

1. validate the canonical profile, local build overrides and local settings sources;
2. acquire the vault lock and recover an interrupted change;
3. parse the installation receipt and compare its profile digest;
4. derive expected plugin membership from the profile and valid optional omissions;
5. compare canonical installs with their declared digests;
6. compare local installs with the override path, Git state, and recorded bytes;
7. rerun each adapter and compare the regenerated file with native state;
8. report changes to governed configuration;
9. release the vault lock.

Each comparison of the check runs as a step. A step applies one rule to one file or folder of the vault. An injected cursor records the step in progress. Therefore, the command line locates the first drift, and the error classes stay unchanged. The [findings output](adr/findings-output.md) fixes the rules and the location of each.

Release files and mutable plugin state remain separate. Release files have canonical digests. A declared mutable JSON file may change after installation, but it must remain valid JSON at its exact lowercase root-level path. Undeclared files, directories, symbolic links and other mutable file types fail verification.

## File formats

Each versioned file declares its format in the key `_schema`, as its first key:

| File                                    | Written by     | `_schema`                       |
| --------------------------------------- | -------------- | ------------------------------- |
| canonical record `obsidian-plugins.yml` | the researcher | `kataskeue:obsidian-plugins@1`  |
| installation receipt                    | `apply`        | `kataskeue:receipt@2`           |
| transaction journal                     | `apply`        | `kataskeue:transaction@1`       |
| source of the `sieve@1.0.2` adapter     | the researcher | `sieve:configuration@1`         |
| source of the Full Calendar adapter     | the researcher | `full-calendar:configuration@1` |
| `ekphrasis.yml`                         | the researcher | `ekphrasis:configuration@1`     |

The canonical record is not a configuration file of Kataskeue, because the command reads it from `--record` or from the root, and no configuration lookup finds it. Therefore, its type is `obsidian-plugins`.

The reader compares the whole value with the one identifier that it supports. A command stops with status 2 when the key is absent, when the key holds another value, or when the file keeps the retired key `format_version`, in the text output and in the findings log alike. The message names the expected value. Such a file is an unusable input and not a drift of the vault, so the findings log records a failed run and no result.

The receipt and the journal record what a past run of `apply` did, so no command reconstructs them from the current state. Therefore, `check` rejects a receipt that keeps the retired key. The command `apply` replaces the whole managed state and writes a new receipt without reading the previous one. The receipt holds digests of the record and of the source files, so editing its key by hand does not make it valid once those files declare `_schema`: `apply` is the route to a current receipt.
