# yamlover / json5p — JetBrains plugin

File-type support and syntax highlighting for the **yamlover** family in
IntelliJ-based IDEs: `.yo` (YAML + pointers) and `.json5p` (JSON5 + pointers),
plus highlighting of `yamlover`/`json5p` fenced code blocks inside Markdown.

## Status

- Registers the **`.yo`** and **`.json5p`** file types, each with an icon.
- **Syntax highlighting** via lightweight heuristic lexers (`YamloverLexer`,
  `Json5pLexer`): comments (`#` for yamlover — only after whitespace/BOL, so `a#b` is one
  scalar; `//` and `/* */` for json5p), pointer/anchor runs (`* & ~ …`) in the **colon
  grammar** (`*: a: b`, `::`/`:::` scope, relative indexes `[.±k]`; `/` is an ordinary key
  char — SEPARATOR.md), **block scalars** (`|`/`>` — the indented body is opaque, not
  re-lexed), strings, keys, keywords (incl. `.inf`/`.nan`/hex numbers), and punctuation.
- **Markdown injection**: ` ```yamlover ` and ` ```json5p ` fenced code blocks are
  highlighted inside `.md` files (`YamloverCodeFenceLanguageProvider`; loads only when
  the bundled Markdown plugin is present).
- **Pointer navigation** (Ctrl+B / Ctrl+click) in the colon grammar, understanding the
  omni chapter shape: scalar self-values and document tag lines take no position; a titled
  subchapter's (`- Title` + deeper body), a compact container's (`- - x`), and a keyed
  omni's (`world: World` + deeper body) children are indexed. There is no anchor namespace
  — `*name` is pure path lookup. `::`/`:::` cross-tree links wait for the engine.

This is intentionally a *thin* first cut. It does **not** yet build PSI, resolve
references, or talk to the engine — the grammar is a heuristic reimplementation of the TS
parser (`tools/parser/ts/src/{yamlover,pointer}.ts`), kept in sync by the unit tests.

## Roadmap

1. Replace the heuristic lexer with the **shared yamlover lexer/grammar** (the one
   feeding the parser in `tools/` — see `../../PLAN.md`).
2. PSI + a real parser → structure view, brace matching, folding.
3. **Reference resolution & navigation** across trees (`::`/`:::` project/world links) —
   go-to-definition, find-usages — backed by the **yamlover engine** over its
   protocol (the JetBrains plugin as a thin client / sidecar, per `../../FUTURE.md`).

## Build

Builds with the **Gradle wrapper** (checked in — `gradle/wrapper/gradle-wrapper.properties`
pins the version) + **Kotlin 2.0.21**, a JDK to run Gradle (JDK 21 used here), and **JDK 17**
available for the `jvmToolchain(17)` target (Gradle auto-detects SDKMAN/standard installs).
Network access is needed once to fetch the IntelliJ Platform SDK.

```sh
./gradlew test          # lexer + pointer-navigation unit tests (the sync gate)
./gradlew buildPlugin   # → build/distributions/yamlover-jetbrains-*.zip
./gradlew runIde        # launches a sandbox IDE with the plugin
```

Current version **0.4.0** (the colon-grammar sync — SEPARATOR.md). Built against the
**2023.2 (build 232)** platform with an **open-ended** upper bound (`since-build=232`,
no `until-build`) so one artifact loads on any 2023.2+ backend.

Pin the IDE version in `build.gradle.kts` (`intellijIdeaCommunity("…")`) and the
`sinceBuild`/`untilBuild` range to your target.
