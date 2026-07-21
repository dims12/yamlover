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
- store rendered diagrams in .yamlover
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
- 021 Chunks has slash http://10.9.0.2:5173/73-dev-board/add-board-view.yamlover?format=tag-board#/chunks[1]   but fragments havent' http://10.9.0.2:5173/72-images/eiffel-tower/IMG_20120725_182044.jpg?format=large-icons#yamlover-fragments/mqee46pt-m1wdko +DONE (fragmentAnchorId now keeps the leading `/` → `#/yamlover-fragments/<slug>`, mirroring chunk anchors)
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
- ~~027 POSTPONED: unified REFERENCE-entry UX in the projectional editor~~ — DONE (2026-07-21):
  the `*` pointer cell now hosts the SHARED query-cell kit (query-cells.tsx — the breadcrumb
  machinery in PICK mode): server-backed candidates (`GET /api/query` at the holder), the scope
  ladder (`*` bare / `*:` / `*::`), live TOC filtering through the shared TocFilterSession, TOC
  click inserts the picked path spelled in the chosen scope, Enter reduces the query to a
  link-arity pointer. The tag picker's search row runs on the same kit (annotate.tsx);
  yamlover-editor/pointer-hints.tsx deleted. State tables: QUERY_EDITOR.yamlover (pick mode),
  YAMLOVER_EDITOR.yamlover (pointer_* states).