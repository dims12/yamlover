# FUTURE — platform & architecture direction

Forward-looking notes, not commitments. yamlover is meant to be a **foundation for
many applications** — mind-map / outliner desktop apps, reference managers, image
managers, a tag manager, a JetBrains plugin or custom project type, and more. This
document records how we think the engine should evolve to support that, and the
open decision that drives the implementation language.

## Where we are today

A **thin server, thick client** split:

- The server (`tools/server`) walks the filesystem tree, infers `(type, format)`
  from schema + extension, resolves refs/rels/tags, and serves raw bytes via
  `/api/blob`. It does no conversion.
- The React/TypeScript client does **all** format conversion in-browser (mammoth
  for docx, SheetJS for xls/xlsx, pdf.js, KaTeX, the built-in rtf/csv converters,
  …), fetching only file bytes from the local server.

This keeps `npx yamlover` zero-install and conversions private/local. The one
exception that leaves the machine is **PlantUML** (rendered by the public
plantuml.com unless `VITE_PLANTUML_SERVER` points at a self-hosted instance).

## Why it will shift server-ward

Some work wants to live on a server, and we keep bumping into it:

- **Formats with no good browser library** — legacy `.doc` (→ LibreOffice
  headless), and PlantUML (→ a render process; it's *already* a remote call, so the
  natural first candidate).
- **Run-once-and-cache** work that shouldn't repeat per client — thumbnails, DjVu
  OCR, search indexing, large-file extraction.
- **CPU/memory-heavy** conversions where the browser is the wrong place.

The lever that keeps this clean: a small **`convert(path, format) → bytes/html`**
seam on the server, requested by the client the same way it asks for a blob today.
The renderer registry already isolates each format, so flipping one renderer from
"parse locally" to "fetch server-converted" is a localized change — no rewrite to
evolve toward a "monolithic server."

## The key insight: spec the contract, not the language

yamlover's real asset is the **model** — data-as-a-tree-over-filesystem, with
schema-driven representation, refs/rels/tags, and `(type, format)` → renderer. Every
app on the list above is a *frontend over that same model*.

So the highest-leverage move is **specifying the protocol** (the tree / schema /
blob / future `convert` API, today implicit in `tools/server`) as a versioned
contract — e.g. OpenAPI + JSON-Schema over `/api/tree`, `/api/node`, `/api/blob`,
`/api/convert`. Once that's a real spec, the implementation language becomes
swappable *and pluralizable*: a Kotlin server tomorrow, a Node server today, a Rust
core in between — any client (JetBrains plugin, web, desktop) just speaks the
protocol. **Do this before porting anything.**

## The decision that drives the language

> Does the JetBrains plugin / project-type need to run **in-process**, or can it be
> a **thin client** over a local yamlover server?

- JetBrains plugins are **JVM**. An in-process core there means **Kotlin/JVM**,
  full stop — nothing else embeds cleanly into IntelliJ.
- If "the plugin talks to a local server over HTTP/socket" is acceptable, the core
  language is free and we optimize for the *server*.

This single question mostly settles the table below.

## Options

| Option | Best when | Why / why not |
| --- | --- | --- |
| **Kotlin / JVM (Ktor)** | JetBrains is first-class; conversion is growing | In-process IntelliJ path; the JVM has the **best document libraries** (Apache POI = doc+docx+xls+xlsx in one mature lib, PDFBox, Batik, LibreOffice-UNO); Kotlin Multiplatform keeps native/desktop/web open. Top pick if the plugin matters. |
| **Stay TS / Node** | JetBrains can be a sidecar; desktop = Electron | Lowest migration cost, already built, renderer ecosystem (mammoth/sheetjs/pdf.js) is JS-native. Weak spot is exactly in-process JVM embedding. |
| **Rust core + bindings** | One core embedded everywhere (Node, Python, JVM-JNI, **browser-WASM**) | Most future-proof "embed anywhere"; cleanest FFI; WASM could run inside the existing web client. But slower to build and **weak office-conversion libs** (orchestrate external tools instead). |
| **Go** | Pure server, single-binary distribution | Great *server* and deploy story, but a poor *embedded core* (JVM/Electron can only subprocess it). |
| **C++** | A specific, profiled hot path demands it | **Advised against as the core**: maximum velocity cost, little gain for an orchestration/metadata engine (not a compute kernel). Reserve for measured hotspots only. |

## Recommendation

1. **Write the protocol spec first** (OpenAPI/JSON-Schema over the existing
   endpoints + a future `/api/convert`). This *is* the "yamlover platform"; it makes
   the language choice per-component instead of global.
2. If the **JetBrains project-type is a genuine product surface** → make the core
   **Kotlin/JVM + Ktor**: the only choice giving in-process IntelliJ *and* the
   strongest server-side conversion ecosystem (where we were already heading with
   `.doc`/PlantUML), with Compose/KMP as a bonus for native desktop. Keep the
   current React/TS client as the web frontend over it.
3. If JetBrains can be a **thin client** → **stay on TS/Node** and grow the monolith
   there. Cheapest path; we lose almost nothing except native JVM embedding.

The **Rust-core-with-bindings** route is the most elegant "one engine, every host"
story, and worth serious consideration if we dislike maintaining multiple server
implementations — the catch is leaning on external processes for office/PDF
conversion rather than in-language libraries.

One-line summary: **not C++. Kotlin/JVM if JetBrains is first-class; otherwise stay
TypeScript — and either way, spec the protocol before porting anything.**

## Open question to settle

How much weight is on the JetBrains piece — a real product surface, or a "would be
nice"? That mostly decides between Kotlin/JVM and staying on TypeScript.
