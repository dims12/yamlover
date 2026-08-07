# yamlover / json5p — JetBrains plugin

File-type support and syntax highlighting for the **yamlover** family in
IntelliJ-based IDEs: `.yo` (YAML + pointers) and `.json5p` (JSON5 + pointers),
plus highlighting of `yamlover`/`json5p` fenced code blocks inside Markdown.

## Status

- Registers the **`.yo`** (plus the legacy `.yamlover`, read forever) and **`.json5p`**
  file types, each with an icon.
- **Syntax highlighting** via one shared heuristic engine (`HlLexerBase`, the Kotlin
  port of `tools/parser/ts/src/highlight.ts` — the same ruleset the web client renders):
  comments (`#` for yamlover — only after whitespace/BOL, so `a#b` is one scalar; `//`
  and `/* */` for json5p), pointer/anchor runs (`* & ~ …`) in the **colon grammar**
  (`*: a: b`, `::`/`:::` scope, relative indexes `[.±k]`; `/` is an ordinary key char —
  docs/language/pointers/paths), **block scalars** (`|`/`>` header signs + an opaque body, not re-lexed),
  strings and **quoted keys**, the dedicated `- ` dash and `null`/`~` kinds, and numbers
  by the JS `Number` reading (incl. `.inf`/`.nan`/hex).
- **Markdown injection**: ` ```yamlover ` and ` ```json5p ` fenced code blocks are
  highlighted inside `.md` files (`YamloverCodeFenceLanguageProvider`; loads only when
  the bundled Markdown plugin is present).
- **Pointer navigation** (Ctrl+B / Ctrl+click) in the colon grammar, with the bare-token
  typing rule of the YAML-keys round: a bare-digit portion is a **position** (`: pets: 1`;
  `[n]` reads as the legacy alias), a bare `~` the **null key** (`~: v` entries resolve),
  quotes carry the string reading. Understands the omni chapter shape: scalar self-values
  and document tag lines take no position; a titled subchapter's (`- Title` + deeper
  body), a compact container's (`- - x`), and a keyed omni's (`world: World` + deeper
  body) children are indexed. There is no anchor namespace — `*name` is pure path lookup.
  `::`/`:::` cross-tree links wait for the engine.

This is intentionally a *thin* first cut. It does **not** yet build PSI, resolve
references, or talk to the engine — the grammar is a heuristic reimplementation of the TS
parser (`tools/parser/ts/src/{yamlover,pointer,highlight}.ts`), kept in sync by the unit
tests.

## Roadmap

1. Keep the Kotlin port in lock-step with the shared ruleset
   (`tools/parser/ts/src/highlight.ts`) — a golden-token parity harness (dumps generated
   from `highlight.ts` asserted against the Kotlin lexers, with a CI drift trip-wire) is
   the planned follow-up.
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

Current version **0.5.0** (the highlight.ts parity sync — the YAML-keys round). Built against the
**2023.2 (build 232)** platform with an **open-ended** upper bound (`since-build=232`,
no `until-build`) so one artifact loads on any 2023.2+ backend.

Pin the IDE version in `build.gradle.kts` (`intellijIdeaCommunity("…")`) and the
`sinceBuild`/`untilBuild` range to your target.
