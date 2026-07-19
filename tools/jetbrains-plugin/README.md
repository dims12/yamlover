# yamlover / json5p — JetBrains plugin

File-type support and syntax highlighting for the **yamlover** family in
IntelliJ-based IDEs: `.yamlover` (YAML + pointers) and `.json5p` (JSON5 + pointers),
plus highlighting of `yamlover`/`json5p` fenced code blocks inside Markdown.

## Status (v1)

- Registers the **`.yamlover`** and **`.json5p`** file types, each with an icon.
- **Syntax highlighting** via lightweight heuristic lexers (`YamloverLexer`,
  `Json5pLexer`): comments (`#` for yamlover; `//` and `/* */` for json5p), pointer/
  anchor runs (`* & ~ …`, including `*#/…`, `*/…`, `[n]`), strings, keys, keywords,
  numbers, and punctuation.
- **Markdown injection**: ` ```yamlover ` and ` ```json5p ` fenced code blocks are
  highlighted inside `.md` files (`YamloverCodeFenceLanguageProvider`; loads only when
  the bundled Markdown plugin is present).
- **Pointer navigation** (Ctrl+B / Ctrl+click) understands the omni chapter shape:
  scalar self-values and document tag lines take no position; a titled subchapter's
  (`- Title` + deeper body) and a compact container's (`- - x`) children are indexed.

This is intentionally a *thin* first cut. It does **not** yet build PSI, resolve
references, or talk to the engine.

## Roadmap

1. Replace the heuristic lexer with the **shared yamlover lexer/grammar** (the one
   feeding the parser in `tools/` — see `../../PLAN.md`).
2. PSI + a real parser → structure view, brace matching, folding.
3. **Reference resolution & navigation** for pointers (`*`, `~`, `#/`, `/`, URIs) —
   go-to-definition, find-usages — backed by the **yamlover engine** over its
   protocol (the JetBrains plugin as a thin client / sidecar, per `../../FUTURE.md`).

## Build

Builds with **Gradle 8.14.5** (wrapper checked in) + **Kotlin 2.0.21**, a JDK to run
Gradle (JDK 21 used here), and **JDK 17** available for the `jvmToolchain(17)` target
(Gradle auto-detects SDKMAN/standard installs). Network access is needed once to fetch
the IntelliJ Platform SDK.

```sh
./gradlew buildPlugin   # → build/distributions/yamlover-jetbrains-*.zip
./gradlew runIde        # launches a sandbox IDE with the plugin
```

Verified building on 2026-07-19: produces `build/distributions/yamlover-jetbrains-0.3.0.zip`
(all classes + patched `plugin.xml` + Markdown injection config). Built against the
**2023.2 (build 232)** platform with an **open-ended** upper bound (`since-build=232`,
no `until-build`) so one artifact loads on any 2023.2+ backend.

Pin the IDE version in `build.gradle.kts` (`intellijIdeaCommunity("…")`) and the
`sinceBuild`/`untilBuild` range to your target.
