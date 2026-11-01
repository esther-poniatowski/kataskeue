# Findings output

**Status**: Proposed. The decision implements the Kataskeue row of the [producer migration](https://github.com/esther-poniatowski/elenchos/blob/main/docs/producer-migration.md) of Elenchos, and depends on the [findings profile](https://github.com/esther-poniatowski/elenchos/blob/main/docs/profile.md) of Elenchos, still a draft.

## Problem

The gate Elenchos reads the failures of each domain tool as a log of the Static Analysis Results Interchange Format (SARIF) 2.1.0, written in the findings profile of the gate, version 1. The gate builds the identity of each failure from the tool, the rule, the resource and the locus. The command `check` reported its first drift as one line on standard error. The line named no rule, and its error class did not separate drift from other failures. For instance, a missing runtime file raises a `ProfileError`, and a held lock raises an `OperationLockedError`. Therefore, a reader of the line could not tell a drift of the vault from a failure of the check.

## Decision

### Output option

The command `check` accepts `--format sarif`. With this option, the command writes one log on standard output. The option `--output PATH` writes the log to a file instead, and creates the missing parent folders. The option `--root PATH` names the root of the consumer repository, and the log states every path relative to that root. The root defaults to the current folder, since Elenchos runs each check from the root of the consumer. The vault must lie under the root. The command `apply` refuses `--format sarif`, since it changes the vault instead of checking it. The default `--format text` keeps the line on standard error. In both formats, the exit status is 0 for a complete check without drift, and 1 otherwise.

### Steps and rules

The check runs its comparisons in steps. Each step applies one rule to one file or folder of the vault. The module `src/application/checkSteps.ts` lists the rules and describes each. The log locates a finding about one plugin at the plugin folder, or at a file of that folder. Therefore, reordering the plugins of the profile or of the receipt leaves the identity of the finding unchanged.

| Rule | Resource | Locus |
| --- | --- | --- |
| `receipt/absent`, `receipt/invalid` | `.obsidian/plugin-installation.json` | empty |
| `receipt/profile`, `receipt/runtime`, `receipt/omissions`, `receipt/membership` | `.obsidian/plugin-installation.json` | `/profile_digest`, `/runtime`, `/omitted`, `/plugins` |
| `plugins/directories` | `.obsidian/plugins/`, as a folder | empty |
| `plugins/enabled` | `.obsidian/community-plugins.json` | empty |
| `plugin/source`, `plugin/files`, `plugin/digest`, `plugin/undeclared-files` | the plugin folder | empty |
| the five rules `override/*` | the plugin folder | empty |
| `settings/source`, `settings/receipt` | the plugin folder | empty |
| `plugin/mutable-json` | the declared mutable file | empty |
| `settings/native`, `settings/projected` | the `data.json` of the plugin | empty |

The table writes each path relative to the vault, whereas the log writes it relative to the root. No result holds a region or a discriminator, since each rule applies once to each resource and locus.

### Locating a drift

The check stops at its first drift, as before. An optional `CheckCursor` records the step in progress, and the command line passes it to `checkProfile`. A step that passes clears the cursor, and a step that fails leaves itself current. When a step throws a `DriftError`, a `DigestMismatchError` or a `ProfileError`, the failure is a drift located at that step. Any other error is a failure of the check itself, and so is an error thrown outside a step. The thrown errors keep their classes, so the library API keeps its contract.

Two failures change class. A missing or unparsable receipt, and a missing or unparsable `community-plugins.json`, now raise a `DriftError` instead of an error of the file system or of the JSON parser. The command `apply` writes both files, so their absence is a drift.

### Completeness of a run

| Case | Invocation | `results` |
| --- | --- | --- |
| complete: every step passed | `executionSuccessful: true` | empty |
| partial: a step found a drift | `executionSuccessful: false`, with a notification of level `error` stating that the later steps did not run | the drift |
| failed during the steps | `executionSuccessful: false`, with the error as notification | empty |
| failed before the first step: unreadable inputs, an invalid profile, a vault outside the root | `executionSuccessful: false`, with the error as notification | absent |

The gate reads both incomplete forms as an incomplete check, through its rule `check/incomplete`.

## Alternatives

### Classifying a failure

The criteria are that each result is a drift of the vault, that the library keeps its error classes, and that the check keeps its comparisons.

| Strategy | Advantage | Limitation | Verdict |
| --- | --- | --- | --- |
| classify by error class alone | no change to the check | a `ProfileError` reports both a missing runtime file and an invalid profile, and no error carries its file | rejected |
| rewrap each failure of a step as a `DriftError` carrying its location | the error holds its finding | changes the class received by callers and tests, such as the `ProfileError` of an invalid mutable file | rejected |
| record the step in progress in an injected cursor | keeps the classes; locates every failure of a step, including failures raised by shared helpers | the check wraps each comparison in a step | selected |

### First drift or every drift

| Strategy | Advantage | Limitation | Verdict |
| --- | --- | --- | --- |
| report the first drift, in a partial run | keeps the check unchanged; one remedy, `apply`, repairs every drift | a run reveals one drift; the gate cannot tolerate a drift, since an incomplete run blocks | selected |
| collect every drift | one run reveals every drift; a tolerated drift no longer hides the next one | a drift of the receipt or of the plugin set makes the per-plugin comparisons meaningless, so the check would need a rule tracking which drift causes which | rejected |

The second strategy would win if a consumer needed to tolerate one drift while checking the rest of the vault. No consumer has needed this so far: a drift has one remedy, `apply`, and `apply` restores the whole profile.

### Location of a plugin finding

| Strategy | Advantage | Limitation | Verdict |
| --- | --- | --- | --- |
| the plugin folder of the vault | stable under reordering; names the state that drifted | a drift of a settings source in the consumer repository is located at the plugin, and its message names the source | selected |
| the entry of the plugin in the profile, by JSON Pointer | names the declaration | the pointer holds the index of the plugin, and adding a plugin before it changes that index | rejected |
| the entry of the plugin in the receipt | names the recorded state | same index problem; moreover, each `apply` regenerates the receipt | rejected |

## Consequences

- A new comparison of the check takes a new step and, when no rule fits it, a new rule in `src/application/checkSteps.ts`. Renaming a rule changes the identity of its results, so it requires a rename map in the gate.
- The tests of `tests/materializer.test.ts` check the located step for three rules of the receipt, `plugin/files`, `plugin/undeclared-files` and `plugin/mutable-json`. The tests of `tests/sarif-log.test.ts` check the log for each outcome, and the encoding of paths.
- Every drift ends an incomplete run, so the gate reports it twice: through the result, and through `check/incomplete`.
