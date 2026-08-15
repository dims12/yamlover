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
- **Indentation**: both languages carry their own code-style indent options — **2 columns,
  spaces only** (`YamloverCodeStyleSettingsProvider`), so Tab / Shift+Tab / Enter step like
  YAML instead of falling back to the IDE's catch-all "Other" settings (4 columns, possibly
  a tab character). Configurable per language in *Settings | Editor | Code Style*.
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

Current version **0.7.0** (the keyless `-` segment, flat-row Ctrl+click paving, and flow
`()` punct — caught up to highlight.ts / pointer.ts; 0.6.1 was flat-row colouring; 0.6.0
brought the brand mark as the file-type icon, plus dark variants and a
Marketplace logo). Built against the **2023.2 (build 232)** platform with an **open-ended**
upper bound (`since-build=232`, no `until-build`) so one artifact loads on any 2023.2+ backend.

Pin the IDE version in `build.gradle.kts` (`intellijIdeaCommunity("…")`) and the
`sinceBuild`/`untilBuild` range to your target.

## Release

The artifact to upload to JetBrains Marketplace is the zip named for `rootProject.name` and
the version — `build/distributions/yamlover-jetbrains-<version>.zip` — **not** for this
directory. Bump `version` in `build.gradle.kts` (and the line above) before each release:
Marketplace refuses a version it has already seen.

`buildPlugin` never cleans, so `build/distributions/` holds **every** zip ever built here,
going back versions. Read the version in the filename rather than trusting the newest
timestamp, and rebuild before uploading — a zip can carry the current version number and
still predate the last edit to the sources.

The first upload has to go through the Marketplace web UI by hand; only afterwards can the
`publishPlugin` task push releases (no publishing token is configured here yet).
