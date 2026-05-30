# tools

Reference tooling for working with yamlover entities. The model itself is a
design spec (see the [top-level README](../README.md)); these are small,
self-contained programs that demonstrate it.

- [`walker/`](walker/) — explore a yamlover tree with shell-style `cd` / `ls`,
  navigating the *logical* node structure regardless of how it is physically
  stored.
- [`collector/`](collector/) — assemble a yamlover tree into a single Yamlover
  JSON Schema (inlining every per-directory schema), printed as YAML or JSON.
- [`server/`](server/) — browse a yamlover tree in the web browser:
  `npx yamlover <root>` serves a React SPA with a table-of-contents tree and a
  per-node view (a TypeScript port of the walker read side).
