- binaries should be hyperlinkes +DONE
- bigger collapse expand icons; chevrons? +DONE
- format icons +DONE
- remove concrete icons +DONE
- Incorrect escaping http://calculon:5173/tools/server/package.json/dependencies/%40vitejs/plugin-react +DONE
- http://calculon:5173/tools/server/src/client shows App.tsx: <unparseable App.tsx: YAMLException> +DONE
- JSONs displayed deep DONE?
- Breadcrumb separator should be a slash; another breadcrumb on page +DONE
- If I open URL, TOC is not updated; navigating links also don't update +DONE
- Reformat representation buttons yaml/json schema/instance
- Binary icon should be 0110 in a square +DONE
- Support configurable depth for json/json5p/yaml/yamlover renderers
- Support configurable depth for chapter renderers
- When images, maps etc are inside chapters, not need to complex leaflet controls +DONE (inline chapter chunks render a STATIC preview — EVERY image, native (png/jpeg/…) and decoded (TIFF/HEIC/PSD), goes through ONE shared `StaticImageChunk` (imagemap.tsx): a plain `<img class=chunk-image>`, no Leaflet; the decoded pipeline `DecodedImageView` (decoded.tsx) takes a `chunk` mode and picks static-vs-`PanZoomImage` the same way the native `ImageChunk`/`ImageView` split does. A map is a non-interactive Leaflet map (no drag/zoom/zoomControl/popups, gestures unwired). All wrap in a click-to-open anchor (openable.tsx `OpenChunk`) that SPA-navigates to the resource's own page, where the full pan/zoom viewer lives)
- Tag picker: autocomplete over indexed tags (the path input + bare-name create-on-miss exist; search/completion doesn't — the evaluator is LIVE now: wire the picker to `GET /api/query` with `:: ...: !!<format: x-yamlover-tag>`-style queries)
- ~~Ctrl-PgDn and Ctrl-PgUp to switch to next element in the viewer~~ — DONE as Ctrl/Alt + Down/Up (Ctrl+PgDn/PgUp is a browser tab shortcut; Alt aliases Ctrl for macOS Mission Control): steps the selection through the TOC in document order (App.tsx `flattenToc` + global keydown)
- ~~Once LHS TOC entry clicked, focus should go to RHS~~ — DONE: tree click navigates and focuses the RHS pane (App.tsx `selectFromToc`, `<main tabIndex={-1}>`)
- ~~/examples/50-object-in-overlay/name chooses marklower format by default without any reasons~~ — DONE (marklower is asked for by name; `chunkOf` stamps a chapter's inline chunks)
- /examples/68-math-chapter displays expand chevron in TOC, although it doesn't have any children +DONE (a chapter's TOC `hasChildren` hint now counts SUBCHAPTERS only — `hasSubchapterChild` in engine-api, mirroring the client's `isSubchapter` — so a chunks-only chapter is a leaf; chunks/overlay fields like `yamlover-fragments` no longer trigger a chevron that expands to nothing)
- add light color scheme
- store rendered diagrams in .yo
- impossible to remove fragment tag just after select
- ~~make multiline text values also collapsible~~ — DONE: big scalars (multiline strings as `|` blocks, `!!binary` bytes) fold like containers in the yamlover view (render.tsx `bigScalar`/`BigScalarYaml`)- KML+KMZ render as XML or plaintext
- 001 PDFs/MDs are too wide; limit right margin +DONE
- 002 no indication on PDF load +DONE
- 003 PDF icon should be normal PDF icon +DONE
- 004 Images are centered, should be left aligned as other resources +DONE
- 005 Page #fragment links for PDFs and DJVUs
- 006 Support #fragment links for MDs and ADOCs +DONE
- 007 SVGs are stretched +DONE
- 008 Links in MDs and ADOCs are not working; prepare endpoint, that redirects from these links into our space +DONE (no endpoint needed — relative `<a href>` rewritten to in-app JSON-space paths + SPA-navigated, mirroring the `<img>` rewrite; see markup.tsx `rewriteRelativeLinks`/`markupClick`)
- 007 Tag diagrams are centered, should also be left aligned +DONE
- 010 Support XML, DOC, DOCX
- 011 Support CSV +DONE
- 012 Support links in EPUB
- 013 Bug: if click chevron only (just after page refresh), children don't appear +DONE
- 014 Support PlantUML (text/x-plantuml) source strings, rendered as diagrams +DONE
- 015 Chapter chunks should respect their (type, format): images and PlantUML, not just markdown +DONE
- 016 Make empty folder icons in TOC as normal OS folder icons +DONE
- 017 Make chapter icons in TOC as section sign (§) +DONE
- 018 Chevrons in TOC are kindof 1-2 pixels lover than the icons
- 019 Absent format shows strange http://calculon:5173/README.md
- 020 TXT files shown in markdown format and glitching: http://calculon:5173/53.%20%D0%A4%D0%B8%D0%B7%D0%B8%D0%BA%D0%B0/The%20Theoretical%20Minimum/Torrent%20downloaded%20from%20Darkside%20RG.txt?format=marklower
- 021 Chunks has slash http://10.9.0.2:5173/73-dev-board/add-board-view.yo?format=tag-board#/chunks[1]   but fragments havent' http://10.9.0.2:5173/72-images/eiffel-tower/IMG_20120725_182044.jpg?format=large-icons#yamlover-fragments/mqee46pt-m1wdko +DONE (fragmentAnchorId now keeps the leading `/` → `#/yamlover-fragments/<slug>`, mirroring chunk anchors)
- 022 Table columns are rendered very narrow in MD even if the page width increased, for example http://10.9.0.2:5173/README.md?format=markdown +DONE (GitHub-style `.markup table` layout — `width: max-content` capped at `max-width: 100%` with overflow-x scroll; cells reset the body's `word-break: break-word`, which was what crushed squeezed columns; borders/zebra mirror `.csv-table`)
- 023 Fragment deletion buttons in image renderer should be trashcan icons, not crosses
- 024 Fragment part in URL should update on scroll where possible (in texts)
- ~~025 **DATA LOSS**: `/api/edit` `op:"replace"` over an ANNOTATED chunk drops its overlay~~ — DONE
  (the editor now `emplace`s, which replaces only the facets the payload carries, so the chunk's
  `yamlover-annotations` keyed facet stands; `replace` still drops them, deliberately)
- 026 An annotated chunk is NOT editable in the WYSIWYG editor: `isEditableMarker`
  (chapter-model.ts) requires `type === "string"`, and an annotated chunk's link marker is
  `type: "variant", valueType: "string"` (tagging turns it omni). Route on the VALUE facet like the
  renderer registry does. **Unblocked by 025** — an edit can no longer delete the annotations.
- ~~027 POSTPONED: unified REFERENCE-entry UX in the projectional editor~~ — DONE (2026-07-21;
  re-anchored 2026-08-03 with the legacy editor's deletion): the `*` pointer cell hosts the
  SHARED query-cell kit (query-cells.tsx — the breadcrumb machinery in PICK mode), today via
  yed's server cell registry (renderers/yed-cells.tsx: ServerPointerHole/ServerPointerCell):
  server-backed candidates (`GET /api/query` at the holder), the scope
  ladder (`*` bare / `*:` / `*::`), live TOC filtering through the shared TocFilterSession, TOC
  click inserts the picked path spelled in the chosen scope, Enter reduces the query to a
  link-arity pointer. The tag picker's search row runs on the same kit (annotate.tsx).
  State tables: QUERY_EDITOR.yo (pick mode), YAMLOVER_EDITOR.yo (pointer_* states).
- Support copy to clipboard in all json, json5, json5p, yaml and yamlover renderers and copy/paste in yamlover editor
  +DONE for the EDITOR half (yed: subtree Ctrl+C, selection copy as source, Ctrl+V with the
  sibling splice, JSON/JSON5 sniff, back-edge/size guards — tools/yed/src/paste.ts); the
  read-only renderers' copy buttons stay open
- Design treetable modelling support
- Switching several chunks to titles and pressing done doesn't commit the state +DONE (titled
  childless wraps birth on the FINAL flush — several at once included; and the materialization
  now descends into members LOADED with the page, so a T inside a subchapter persists too)
- Section sign (§) that is marked title #fragments in yed should be aligned with the title baseline +DONE
  (the § is IN FLOW on the heading's baseline now — absolute positioning floated the 12px glyph
  to the line top; self-cancelling margins keep it in the gutter without shifting the title)
- 028 FOCUS observation (2026-08-04, dogfooding docs/server): in the yed chapter editor, after a
  prose-chunk edit FLUSHES and the chunk re-renders, focus was seen landing on the TITLE input
  instead of staying in the chunk (observed on a one-chunk page, caret at the chunk end past a
  typed newline). THE FOCUS LAW says commits never lose the cell; reproduce and pin with a test.
- 029 REFERENCE entry DECOMPOSED into portion cells (2026-08-04, supersedes 027's kit hosting):
  pointer entry is now the key-value gesture repeated, wholly in the PURE editor - the cursor's
  RefEntry (tools/yed/src/state.ts) carries the scope ladder + portion cells, the `portion`
  grammar lives in grammar/dispatch.ts + grammar/portions.ts (`:` splits or climbs, `[` folds an
  index, Backspace merges/descends, Enter joins and parses-or-refuses; cursor-level commits -
  the document holds the OLD pointer or nothing until the reference parses). COMPLETION is an
  optional advisory seam (tools/yed/src/complete.ts HintProvider): the debug editor answers from
  the in-memory document (docHints - the pointer entrance pops server-free now), the server from
  the live tree (renderers/yed-cells.tsx treeHints over GET /api/query). ServerPointerHole /
  holePick / the kit hosting in the reference cells are RETIRED; the query-cell kit remains the
  breadcrumb's and tag picker's. Docs: ::server:editor:pick-kit + the pointer_* state pages.
  Follow-up +DONE (2026-08-05): the TOC filter session + TOC-click insertion RE-PLUGGED onto
  the portion cells, HOST-SIDE only (renderers/yed-toc-pick.ts useTocRefPick, mounted by
  yed-editor.tsx; the pure editor stays TOC-blind): a live ref edit claims the session, the
  joined query feeds `GET /api/query?shape=filter` at the holder, and a TOC click spells the
  picked path into the cells (pointer-spell, the typed ladder honored) - inserted like a hint,
  the grammar's Enter stays the one commit; eviction/no-session only unplugs the panel. The
  legacy TOC-pick test expectations revived in yed-pointer.test.tsx (session claims/releases,
  pick lands in cells, Enter commits `*pets:0:name`; plus the filter-feed case). Chapter
  source-chunk references still hint-only (no session plug in the embedded chunks yet).
