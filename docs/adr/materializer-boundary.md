# Materializer boundary

**Status**: Accepted.

## Problem

`obsidian-launcher` installs selected public releases and local builds. The launcher preserves undeclared identifiers, plugin directories, and files. Therefore, the launcher alone cannot make native plugin state equal a canonical profile.

## Decision

The materializer delegates to `obsidian-launcher`. The launcher downloads public releases and installs prepared local bundles. The remaining work belongs to the following components:

- the profile parser validates canonical records and local overrides;
- provider ports represent private releases and retained artifacts;
- the digest checker verifies declared files;
- the reconciler preserves explicitly declared mutable JSON files without classifying them as release payload;
- the reconciler makes native state equal to the profile;
- adapters convert governed configuration data;
- the recovery record preserves enough state to reverse an interrupted change;
- receipts record installed state for subsequent checks.

Consumer repositories own `obsidian-plugins.yml` and their portable settings. The package contains no consumer paths, plugin selections, or repository vocabulary.

The package exposes the direct commands `apply` and `check`. The package provides no umbrella command for other repository tools.

## Replacement criterion

The adapter tests cover the behavior delegated to the launcher. The launcher remains the dependency while its library supplies most of that behavior. Replace the launcher if the materializer must reproduce most of the download or install code.

## Consequences

The boundary yields the following properties:

- TypeScript permits direct use of the launcher library without a subprocess bridge.
- Provider interfaces isolate remote releases and retained artifacts.
- A separate port reports the state of each local source, and the receipt records that state.
- A staging vault prevents invalid candidates from changing a target vault.
- State recorded on disk restores the preceding managed state after an interrupted process.
- Schema resources rendered by plugins remain outside the package.
