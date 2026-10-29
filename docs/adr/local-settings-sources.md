# Local settings sources

**Status**: Accepted.

## Problem

A consumer may need another complete settings source for one checkout. The canonical profile must remain portable, and delivery checks must ignore machine-local choices. The mechanism must also remain common to every projected adapter.

## Decision

The commands accept a separate untracked local-settings record through the flag `--local-settings`. The record maps a plugin identifier to a repository-relative source path. The plugin must use the `losslessly-projected` policy.

The selected local source replaces the complete canonical source. The materializer never merges the two sources. Paths resolve from the canonical profile directory. Therefore, `apply` and `check` select the same files when they receive the same local record.

The receipt records whether each projected source is canonical or local. Delivery mode rejects every local build override and local settings source. During `check`, the adapter regenerates the expected native file from the selected source and its declared repository inputs.

## Alternatives

The canonical profile must remain portable. The tool must expose every selected source explicitly. The analysis compares three routes against these criteria.

| Strategy | Advantage | Limitation | Verdict |
| --- | --- | --- | --- |
| let each adapter discover a local file | requires no extra flag | hides ambient state and duplicates precedence rules across adapters | rejected |
| name a local path in the canonical profile | keeps paths in one record | makes portable state describe a local choice and still needs a selector | rejected |
| pass a generic local-settings record | makes the choice explicit and keeps adapters independent of delivery policy | adds one invocation input | selected |

## Consequences

The selected route fixes four properties:

- The canonical profile contains no machine-local settings path.
- Build overrides and settings sources use separate records.
- Applying local state requires passing the local record again to `check`.
- A changed directory inventory invalidates a projected receipt even when the source file remains unchanged.
