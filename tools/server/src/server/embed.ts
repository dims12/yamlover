/**
 * embed.ts — surgical, indentation-aware edits that EMBED fragments and annotations into a
 * yamlover host body (a standalone `*.yo` document, or a directory's
 * `.yo/body.yo` overlay). Pure string→string transforms, like the chapter-list
 * insertion in engine-api.ts — the parser tracks no spans, so we edit the source text directly,
 * preserving the rest of the file (comments, formatting). See docs/annotations.
 *
 * A host body is YAML-shaped: a mapping's keys at one indent; a sequence's `- ` items at the
 * SAME indent as their key; an item/value body 2 deeper. We descend a `within` path of mapping
 * KEYS (creating any that are absent, as empty blocks) to reach a target node, then:
 *   • append an element to its `yamlover-annotations:` sequence (creating the key), or
 *   • upsert a `<slug>:` entry into its `yo: fragments:` mapping (creating the keys).
 *
 * Index (sequence-position) descent — e.g. tagging a chapter CHUNK, which would turn its
 * block-scalar into an omni node — is intentionally NOT handled here; the server resolves such a
 * target to a key-addressable host. Keep this module free of fs / Store coupling so it unit-tests
 * in isolation (see test/embed.test.ts) — the one import below is the parser's PURE spelling law,
 * which this module must not restate (a second `- ` grammar here is how `-: v` went unseen).
 */

import { seqMarkLen, stripSeqMark } from "../../../parser/ts/src/serialize-common.ts";

const ANNOTATIONS_KEY = "yamlover-annotations";
/** Fragments nest under the node's reserved `yo:` key: `yo:` → `fragments:` → `<slug>:`
 *  (docs/annotations/fragments). */
export const YO_KEY = "yo";
export const FRAGMENTS_SUBKEY = "fragments";
const THUMBNAILS_KEY = "yamlover-thumbnails";

const indentOf = (line: string): number => { let i = 0; while (line[i] === " ") i++; return i; };
const isContentLine = (line: string): boolean => { const t = line.trim(); return t.length > 0 && !t.startsWith("#"); };

/** The indent of the first content line — the top mapping's key column (0 for most bodies). */
function firstContentIndent(lines: string[]): number {
  for (const l of lines) if (isContentLine(l)) return indentOf(l);
  return 0;
}

/** A yamlover plain/quoted key token: bare when it is a safe plain scalar, else double-quoted
 *  (JSON escapes — the subset the parser reads back). Mirrors how filenames with dots/spaces are
 *  authored as overlay keys (e.g. `"S0002-9904.pdf":`). */
export function keyToken(key: string): string {
  // an all-digit key must quote: a bare `12:` is a POSITION under the YAML-keys round,
  // and the parser refuses it as a key outright
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(key) && !/^\d+$/.test(key) ? key : JSON.stringify(key);
}

/** Line index of `key:` at exactly `indent` within [lo,hi); -1 once the mapping ends (a dedent
 *  to a shallower content line). Skips deeper lines (a nested value / block scalar). */
function findKeyLine(lines: string[], lo: number, hi: number, indent: number, key: string): number {
  const tok = keyToken(key);
  for (let i = lo; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < indent) return -1; // left the mapping
    if (ind !== indent) continue; // deeper — a nested value
    const t = lines[i].trim();
    if (t === `${key}:` || t.startsWith(`${key}: `) || t === `${tok}:` || t.startsWith(`${tok}: `)) return i;
  }
  return -1;
}

/** How many of `keys[k..]` the line spells FLAT — the flattening serializer's single-chain
 *  row (`yo: fragments:`, docs/language/flattening): each upcoming walk key is stripped off
 *  the line's head in turn, and consumption stops at the first remainder that is not the
 *  next key (a value, a deeper flat tail, the line's end). At least 1 — the caller already
 *  matched `keys[k]`. Without this the descent saw `yo: fragments:` as `yo:` alone and grew
 *  a SECOND nested `fragments:` mapping (the reported `…fragments: fragments: <slug>`). */
function flatRun(line: string, keys: string[], k: number): number {
  let rest = line.trim();
  let n = 0;
  while (k + n < keys.length && rest !== "") {
    const key = keys[k + n];
    const tok = [key, keyToken(key)].find((t) => rest === `${t}:` || rest.startsWith(`${t}: `));
    if (tok === undefined) break;
    rest = rest === `${tok}:` ? "" : rest.slice(tok.length + 2);
    n++;
  }
  return Math.max(1, n);
}

/** Walk `end` back over trailing blank lines, so an insert lands right after the last content. */
function trimBack(lines: string[], floor: number, end: number): number {
  let e = end;
  while (e > floor + 1 && !isContentLine(lines[e - 1])) e--;
  return e;
}

/** The end (exclusive) of the block owned by the content starting at `from`, whose own lines sit
 *  at >= `indent`: the first later content line shallower than `indent`, sans trailing blanks. */
function blockEnd(lines: string[], from: number, hi: number, indent: number): number {
  let last = from;
  for (let i = from; i < hi; i++) {
    if (!isContentLine(lines[i])) continue;
    if (indentOf(lines[i]) < indent) return trimBack(lines, last, i);
    last = i;
  }
  return trimBack(lines, last, hi);
}

export interface Region { lo: number; hi: number; indent: number } // a mapping body: child keys at `indent`, within [lo,hi)

/** Descend the mapping-KEY path `within` to the target node's body region, CREATING any missing
 *  key as an empty block (so a fresh overlay grows the `"file":` → `yo:` → `fragments:` →
 *  `<slug>:` spine on demand). Mutates `lines` in place; returns the region under the last key. */
export function reachBody(lines: string[], within: string[]): Region {
  let start: Region = { lo: 0, hi: lines.length, indent: firstContentIndent(lines) };
  if (lines.length === 1 && lines[0] === "") { lines.length = 0; start = { lo: 0, hi: 0, indent: 0 }; } // empty file
  return reachBodyAt(lines, start, within);
}

/** The body region owned by the key at line `L` (its own lines deeper than `indent`, within `hi`).
 *  The child key column: a deeper content line's indent if the node already has a block body, else
 *  key-indent + 2 (a leaf/inline value gains its first field there — an omni node). */
function bodyUnder(lines: string[], L: number, hi: number, indent: number): Region {
  const bodyLo = L + 1;
  const bodyHi = blockEnd(lines, bodyLo, hi, indent + 1); // anything deeper than the key
  let childIndent = indent + 2;
  for (let i = bodyLo; i < bodyHi; i++) {
    if (isContentLine(lines[i]) && indentOf(lines[i]) > indent) { childIndent = indentOf(lines[i]); break; }
  }
  return { lo: bodyLo, hi: bodyHi, indent: childIndent };
}

/** {@link reachBody}'s mapping-KEY descent, but starting from an already-resolved `start` region
 *  rather than the file root — so a host reached by NON-key descent (a chapter chunk, by index) can
 *  then descend its own keyed fields (`yo`/`fragments`/`<slug>`). Creates missing keys. */
export function reachBodyAt(lines: string[], start: Region, within: string[]): Region {
  let { lo, hi, indent } = start;

  for (let k = 0; k < within.length; ) {
    const key = within[k];
    const L = findKeyLine(lines, lo, hi, indent, key);
    if (L < 0) {
      const at = trimBack(lines, lo - 1, hi); // append the new key at the end of the current body
      lines.splice(at, 0, `${" ".repeat(indent)}${keyToken(key)}:`);
      lo = at + 1; hi = at + 1; indent += 2; // its (empty) body
      k++;
      continue;
    }
    // a FLAT row spells several of the upcoming keys on this one line (`yo: fragments:`) —
    // the walk consumes them all; the region is the line's own block either way
    const consumed = flatRun(lines[L], within, k);
    ({ lo, hi, indent } = bodyUnder(lines, L, hi, indent));
    k += consumed;
  }
  return { lo, hi, indent };
}

/** READ-ONLY descent to the body region at `within` — null when any key is absent. The lookup the
 *  prune path needs: {@link reachBody} would re-CREATE a key that a removal just deleted. */
function findBody(lines: string[], within: string[]): Region | null {
  let region: Region = { lo: 0, hi: lines.length, indent: firstContentIndent(lines) };
  for (let k = 0; k < within.length; ) {
    const L = findKeyLine(lines, region.lo, region.hi, region.indent, within[k]);
    if (L < 0) return null;
    const consumed = flatRun(lines[L], within, k); // the flat row (`yo: fragments:`) reads here too
    region = bodyUnder(lines, L, region.hi, region.indent);
    k += consumed;
  }
  return region;
}

/** Start lines of the `- ` items of a sequence whose key sits at `indent` (items at the same
 *  indent), scanning the region body for the `key:` then its items. */
function seqItemLines(lines: string[], region: Region, key: string): { keyLine: number; items: number[]; end: number } | null {
  const keyLine = findKeyLine(lines, region.lo, region.hi, region.indent, key);
  if (keyLine < 0) return null;
  const items: number[] = [];
  let end = keyLine + 1;
  for (let i = keyLine + 1; i < region.hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < region.indent) break;
    if (ind === region.indent) {
      const t = lines[i].trim();
      if (seqMarkLen(t) !== null) { items.push(i); end = i; continue; }
      break; // a sibling key at the list indent → the sequence ended
    }
    end = i; // deeper — the current item's body
  }
  return { keyLine, items, end: trimBack(lines, end, region.hi) };
}

/** Append one annotation element (rendered at the list indent) to the `yamlover-annotations:`
 *  sequence of the node addressed by `within`, creating the key (and any missing path) if absent.
 *  `render(indent)` returns the element's source lines (a `- *…tag` item, or a `- {…}` object). */
export function appendAnnotation(text: string, within: string[], render: (indent: number) => string[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  appendAnnotationAt(lines, reachBody(lines, within), render);
  return lines.join("\n") + "\n";
}

/** {@link appendAnnotation} rooted at an already-resolved `region` (mutates `lines` in place) — for
 *  a host the mapping-key `reachBody` can't reach, e.g. a chapter CHUNK reached by index descent. */
export function appendAnnotationAt(lines: string[], region: Region, render: (indent: number) => string[]): void {
  const seq = seqItemLines(lines, region, ANNOTATIONS_KEY);
  if (!seq) {
    const at = trimBack(lines, region.lo - 1, region.hi);
    lines.splice(at, 0, `${" ".repeat(region.indent)}${ANNOTATIONS_KEY}:`, ...render(region.indent));
  } else {
    lines.splice(seq.end, 0, ...render(region.indent));
  }
}

/** Upsert an `<entryKey>:` entry into the mapping at `mapPath` under the node addressed by
 *  `within`, creating the map keys (and any missing path) if absent. `render(indent)` returns
 *  the entry's source lines INCLUDING the `<entryKey>:` line, at the mapping's child indent. An
 *  entry whose key already exists is REPLACED (its whole block). The shared engine behind
 *  {@link upsertFragment} and {@link upsertThumbnail}. `mapPath` rides ONE walk with `within`,
 *  so a flat-spelled chain (`yo: fragments:`) is descended, never doubled. */
function upsertMapEntry(text: string, within: string[], mapPath: string[], entryKey: string, render: (indent: number) => string[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  upsertMapEntryAt(lines, reachBody(lines, [...within, ...mapPath]), entryKey, render);
  return lines.join("\n") + "\n";
}

/** {@link upsertMapEntry}'s entry half, rooted at the mapping's already-resolved BODY region
 *  (mutates `lines`): replace the existing `<entryKey>:` block, else append at the body's end. */
export function upsertMapEntryAt(lines: string[], body: Region, entryKey: string, render: (indent: number) => string[]): void {
  const existing = findKeyLine(lines, body.lo, body.hi, body.indent, entryKey);
  if (existing >= 0) {
    const end = blockEnd(lines, existing + 1, body.hi, body.indent + 1);
    lines.splice(existing, end - existing, ...render(body.indent));
  } else {
    const at = trimBack(lines, body.lo - 1, body.hi);
    lines.splice(at, 0, ...render(body.indent));
  }
}

/** Replace the `<key>:` SEQUENCE entry — its key line AND its same-indent `- ` items — in the
 *  mapping body `region`, else append it at the body's end. Unlike {@link upsertMapEntryAt},
 *  whose replaced extent is the key's DEEPER block, a sequence's items sit at the key's OWN
 *  indent (the same-indent rule, file header) — the extent must swallow them too, or a rewrite
 *  would strand the old items as orphan rows. `render(indent)` returns the entry's source lines
 *  INCLUDING the key line. Mutates `lines`. */
export function replaceSeqEntryAt(lines: string[], region: Region, key: string, render: (indent: number) => string[]): void {
  const keyLine = findKeyLine(lines, region.lo, region.hi, region.indent, key);
  if (keyLine < 0) {
    const at = trimBack(lines, region.lo - 1, region.hi);
    lines.splice(at, 0, ...render(region.indent));
    return;
  }
  let end = keyLine + 1;
  for (let i = keyLine + 1; i < region.hi; i++) {
    if (!isContentLine(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ind < region.indent) break;
    if (ind === region.indent && seqMarkLen(lines[i].trim()) === null) break; // a sibling key — the sequence ended
    end = i + 1; // an item start, or the current item's deeper body
  }
  lines.splice(keyLine, trimBack(lines, keyLine, end) - keyLine, ...render(region.indent));
}

/** Upsert a `<slug>:` entry into the `yo: fragments:` mapping of the node addressed by
 *  `within`, creating the keys (and any missing path) if absent. `render(indent)` returns the
 *  fragment's source lines INCLUDING the `<slug>:` line, at the mapping's child indent. A slug
 *  that already exists is REPLACED (its whole block). */
export function upsertFragment(text: string, within: string[], slug: string, render: (indent: number) => string[]): string {
  return upsertMapEntry(text, within, [YO_KEY, FRAGMENTS_SUBKEY], slug, render);
}

/** Drop the bare `key:` line at `region` when its block holds no content — the husk pruner for a
 *  `yo:` key whose `fragments:` mapping was just removed. Mutates `lines`; returns whether it
 *  dropped anything. */
export function pruneEmptyKeyAt(lines: string[], region: Region, key: string): boolean {
  const L = findKeyLine(lines, region.lo, region.hi, region.indent, key);
  if (L < 0) return false;
  const t = lines[L].trim();
  if (t !== `${key}:` && t !== `${keyToken(key)}:`) return false; // an inline value — real data
  const body = bodyUnder(lines, L, region.hi, region.indent);
  for (let i = body.lo; i < body.hi; i++) if (isContentLine(lines[i])) return false;
  lines.splice(L, Math.max(1, body.hi - L));
  return true;
}

// --------------------------------------------------------------------------- //
// MEMBERSHIP BOOKMARKS (docs/annotations/applications): applying an onto is one
// own-line `&…:-` bookmark on the target — written at the TOP of the node's field
// block (the canonical after-the-value position), removed by needle match.
// Bookmark lines are not entries, so a scalar carrying only bookmarks stays a scalar.
// --------------------------------------------------------------------------- //

const isBookmarkLine = (line: string): boolean => line.trim().startsWith("&");

/** Append a membership bookmark line (`tokens[0]`, e.g. `&::ontos:topic:math:-`) at the END of
 *  the node's field block — the position the annotate flow has always grown a node from — plus
 *  any further `tokens` (parameter field lines) right behind it. Mutates `lines`. */
export function appendBookmarkAt(lines: string[], region: Region, tokens: string[]): void {
  const at = trimBack(lines, region.lo - 1, region.hi);
  lines.splice(at, 0, ...tokens.map((t) => `${" ".repeat(region.indent)}${t}`));
}

/** {@link appendBookmarkAt} by mapping-key path (creates missing keys). */
export function appendBookmark(text: string, within: string[], tokens: string[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  appendBookmarkAt(lines, reachBody(lines, within), tokens);
  return lines.join("\n") + "\n";
}

/** Remove every bookmark line of the node at `region` whose trimmed text matches `predicate`.
 *  `region` is a thunk (splices shift indices). Returns whether anything was removed. */
export function removeBookmarkAt(lines: string[], region: () => Region, predicate: (line: string) => boolean): boolean {
  let removed = false;
  for (;;) {
    const r = region();
    let hit = -1;
    for (let i = r.lo; i < r.hi; i++) {
      if (isContentLine(lines[i]) && indentOf(lines[i]) === r.indent && isBookmarkLine(lines[i]) && predicate(lines[i].trim())) { hit = i; break; }
    }
    if (hit < 0) break;
    lines.splice(hit, 1);
    removed = true;
  }
  return removed;
}

/** {@link removeBookmarkAt} by mapping-key path (read-only descent — absent path is a no-op). */
export function removeBookmark(text: string, within: string[], predicate: (line: string) => boolean): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = findBody(lines, within);
  if (!region) return text;
  return removeBookmarkAt(lines, () => findBody(lines, within) ?? region, predicate) ? lines.join("\n") + "\n" : text;
}

/** Whether the node at `region` still carries any membership bookmark line. */
export function bookmarksRemainAt(lines: string[], region: Region): boolean {
  for (let i = region.lo; i < region.hi; i++) {
    if (isContentLine(lines[i]) && indentOf(lines[i]) === region.indent && isBookmarkLine(lines[i])) return true;
  }
  return false;
}

/** {@link bookmarksRemainAt} by mapping-key path (read-only). */
export function bookmarksRemain(text: string, within: string[]): boolean {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = findBody(lines, within);
  return region !== null && bookmarksRemainAt(lines, region);
}

/** Drop an emptied `yo:` husk on the node at `within` (text-level twin of
 *  {@link pruneEmptyKeyAt}) — after the last fragment went, the reserved key must not linger. */
export function pruneEmptyYo(text: string, within: string[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = findBody(lines, within);
  if (!region) return text;
  return pruneEmptyKeyAt(lines, region, YO_KEY) ? lines.join("\n") + "\n" : text;
}

/** Upsert a `[w, h]:` entry into the `yamlover-thumbnails:` mapping of the node addressed by
 *  `within` (an omni overlay on the original blob — parallel to `yo: fragments:`), creating
 *  the key (and any missing path) if absent. `render(indent)` returns the entry's source line
 *  INCLUDING the resolution key. The same `[w, h]` resolution is REPLACED if already present. */
export function upsertThumbnail(text: string, within: string[], resKey: string, render: (indent: number) => string[]): string {
  return upsertMapEntry(text, within, [THUMBNAILS_KEY], resKey, render);
}

/** Whether the node at `within` still has at least one `yamlover-annotations:` element. Read-only:
 *  works on a copy, so the descent never mutates the caller's text (the path it descends already
 *  exists). Used to decide whether a just-untagged FRAGMENT is now empty (→ delete it). */
export function annotationsRemain(text: string, within: string[]): boolean {
  const lines = text.replace(/\n$/, "").split("\n");
  return annotationsRemainAt(lines, reachBody(lines, within));
}

/** {@link annotationsRemain} at an already-resolved `region` (read-only). */
export function annotationsRemainAt(lines: string[], region: Region): boolean {
  const seq = seqItemLines(lines, region, ANNOTATIONS_KEY);
  return !!seq && seq.items.length > 0;
}

/** Drop an EMPTIED `yamlover-annotations:` key (present, zero items) at `region` — untagging the
 *  last tag must not leave the key behind as a null-valued orphan. Mutates `lines`; returns
 *  whether the husk was dropped. */
export function pruneEmptyAnnotationsAt(lines: string[], region: Region): boolean {
  const keyLine = findKeyLine(lines, region.lo, region.hi, region.indent, ANNOTATIONS_KEY);
  if (keyLine < 0 || annotationsRemainAt(lines, region)) return false;
  lines.splice(keyLine, 1); // the items sit at the key's own indent, and there are none — one line
  return true;
}

/** Drop keys along `within` (deepest first) that are now EMPTY: a bare `key:` line with nothing
 *  left in its block. An overlay key (a filename block) exists only to host what sat under it, so
 *  once the last entry went the husk chain must go too. A key with an INLINE value is a real data
 *  node — kept, and the walk stops (its ancestors hold it). Mutates `lines`; returns whether
 *  anything was dropped. */
function pruneEmptyKeys(lines: string[], within: string[]): boolean {
  let pruned = false;
  for (let d = within.length; d > 0; d--) {
    const parent = findBody(lines, within.slice(0, d - 1));
    if (!parent) break;
    const L = findKeyLine(lines, parent.lo, parent.hi, parent.indent, within[d - 1]);
    if (L < 0) break;
    const t = lines[L].trim();
    if (t !== `${within[d - 1]}:` && t !== `${keyToken(within[d - 1])}:`) break; // an inline value — keep
    const body = bodyUnder(lines, L, parent.hi, parent.indent);
    let empty = true;
    for (let i = body.lo; i < body.hi; i++) if (isContentLine(lines[i])) { empty = false; break; }
    if (!empty) break; // still hosts something
    lines.splice(L, Math.max(1, body.hi - L));
    pruned = true;
  }
  return pruned;
}

/** The untag AFTERMATH at `within`: drop an emptied `yamlover-annotations:` husk, and — when
 *  `pruneHosts` (an overlay body, whose keys exist only to host overlay entries; never an in-place
 *  document, whose keys are the user's data) — any host keys emptied with it. Read-only descent: a
 *  path the removal already deleted is left alone, never re-created. */
export function pruneEmptyAnnotations(text: string, within: string[], pruneHosts: boolean): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = findBody(lines, within);
  if (!region) return text;
  const droppedHusk = pruneEmptyAnnotationsAt(lines, region);
  const droppedHosts = pruneHosts && pruneEmptyKeys(lines, within);
  return droppedHusk || droppedHosts ? lines.join("\n") + "\n" : text;
}

/** Flat-aware, READ-ONLY lookup of the mapping at `mapPath` under `region`: the physical LINE
 *  that carries the mapping's key (the LAST line consumed — the flat `yo: fragments:` row is
 *  one line for both keys), and the mapping's body. Null when any key is absent. */
function findMapping(lines: string[], region: Region, mapPath: string[]): { line: number; body: Region } | null {
  let r = region;
  let line = -1;
  for (let k = 0; k < mapPath.length; ) {
    const L = findKeyLine(lines, r.lo, r.hi, r.indent, mapPath[k]);
    if (L < 0) return null;
    const consumed = flatRun(lines[L], mapPath, k);
    line = L;
    r = bodyUnder(lines, L, r.hi, r.indent);
    k += consumed;
  }
  return line < 0 ? null : { line, body: r };
}

/** Remove the `<entryKey>:` block from the mapping at `mapPath` under the node at `within`
 *  (e.g. drop one slug from `yo: fragments:`). Returns the text unchanged when the map or entry
 *  is absent. When the mapping is left empty, its key line is removed too — the FLAT spelling
 *  (`yo: fragments:`) drops as the one line it is, so no husk lingers either way. */
export function removeMapEntry(text: string, within: string[], mapPath: string[], entryKey: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = findBody(lines, within);
  if (!region) return text;
  return removeMapEntryAt(lines, region, mapPath, entryKey) ? lines.join("\n") + "\n" : text;
}

/** {@link removeMapEntry} at an already-resolved `region` (mutates `lines`); returns whether anything
 *  was removed (so callers can skip a no-op re-write). */
export function removeMapEntryAt(lines: string[], region: Region, mapPath: string[], entryKey: string): boolean {
  const map = findMapping(lines, region, mapPath);
  if (!map) return false;
  const entry = findKeyLine(lines, map.body.lo, map.body.hi, map.body.indent, entryKey);
  if (entry < 0) return false;
  const end = blockEnd(lines, entry + 1, map.body.hi, map.body.indent + 1);
  lines.splice(entry, end - entry);
  // the mapping now empty (no child key left) → drop its key line (and block) as well
  const mapIndent = indentOf(lines[map.line]);
  const newHi = blockEnd(lines, map.line + 1, lines.length, mapIndent + 1);
  let hasChild = false;
  for (let i = map.line + 1; i < newHi; i++) {
    if (isContentLine(lines[i]) && indentOf(lines[i]) === map.body.indent) { hasChild = true; break; }
  }
  if (!hasChild) lines.splice(map.line, newHi - map.line);
  return true;
}

/** Remove annotation element(s) from the `yamlover-annotations:` of the node at `within` — EVERY
 *  `- ` item whose trimmed text matches `predicate` (not just the first), so untagging clears a tag
 *  fully even if a create race left it applied twice. Returns the text unchanged if none match. The
 *  block of a multi-line object item is removed whole. Re-descends after each splice (indices shift).*/
export function removeAnnotation(text: string, within: string[], predicate: (itemText: string) => boolean): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return removeAnnotationAt(lines, () => reachBody(lines, within), predicate) ? lines.join("\n") + "\n" : text;
}

/** {@link removeAnnotation} at a region (mutates `lines`); returns whether anything was removed.
 *  `region` is a THUNK because splices shift line indices — it is re-resolved after each removal
 *  (the mapping-key path via `reachBody`, or a re-scanned chunk region). */
export function removeAnnotationAt(lines: string[], region: () => Region, predicate: (itemText: string) => boolean): boolean {
  let removed = false;
  for (;;) {
    const seq = seqItemLines(lines, region(), ANNOTATIONS_KEY);
    if (!seq) break;
    const k = seq.items.findIndex((i) => { const t = lines[i].trim(); return predicate(stripSeqMark(t) ?? t); });
    if (k < 0) break;
    const i = seq.items[k];
    const next = k + 1 < seq.items.length ? seq.items[k + 1] : seq.end;
    lines.splice(i, next - i);
    removed = true;
  }
  return removed;
}
