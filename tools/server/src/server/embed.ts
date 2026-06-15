/**
 * embed.ts — surgical, indentation-aware edits that EMBED fragments and annotations into a
 * yamlover host body (a standalone `*.yamlover` document, or a directory's
 * `.yamlover/body.yamlover` overlay). Pure string→string transforms, like the chapter-list
 * insertion in engine-api.ts — the parser tracks no spans, so we edit the source text directly,
 * preserving the rest of the file (comments, formatting). See ANNOTATIONS.md.
 *
 * A host body is YAML-shaped: a mapping's keys at one indent; a sequence's `- ` items at the
 * SAME indent as their key; an item/value body 2 deeper. We descend a `within` path of mapping
 * KEYS (creating any that are absent, as empty blocks) to reach a target node, then:
 *   • append an element to its `yamlover-annotations:` sequence (creating the key), or
 *   • upsert a `<slug>:` entry into its `yamlover-fragments:` mapping (creating the key).
 *
 * Index (sequence-position) descent — e.g. tagging a chapter CHUNK, which would turn its
 * block-scalar into an omni node — is intentionally NOT handled here; the server resolves such a
 * target to a key-addressable host. Keep this module free of fs / Store coupling so it unit-tests
 * in isolation (see test/embed.test.ts).
 */

const ANNOTATIONS_KEY = "yamlover-annotations";
const FRAGMENTS_KEY = "yamlover-fragments";
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
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
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

interface Region { lo: number; hi: number; indent: number } // a mapping body: child keys at `indent`, within [lo,hi)

/** Descend the mapping-KEY path `within` to the target node's body region, CREATING any missing
 *  key as an empty block (so a fresh overlay grows the `"file":` → `yamlover-fragments:` →
 *  `<slug>:` spine on demand). Mutates `lines` in place; returns the region under the last key. */
function reachBody(lines: string[], within: string[]): Region {
  let lo = 0;
  let hi = lines.length;
  let indent = firstContentIndent(lines);
  if (lines.length === 1 && lines[0] === "") { lines.length = 0; hi = 0; indent = 0; } // empty file

  for (const key of within) {
    const L = findKeyLine(lines, lo, hi, indent, key);
    if (L < 0) {
      const at = trimBack(lines, lo - 1, hi); // append the new key at the end of the current body
      lines.splice(at, 0, `${" ".repeat(indent)}${keyToken(key)}:`);
      lo = at + 1; hi = at + 1; indent += 2; // its (empty) body
      continue;
    }
    const inline = lines[L].slice(indentOf(lines[L])).slice(`${lines[L].trim().split(":")[0]}:`.length);
    const bodyLo = L + 1;
    const bodyHi = blockEnd(lines, bodyLo, hi, indent + 1); // anything deeper than the key
    // the child key column: a deeper content line's indent if the node already has a block body,
    // else key-indent + 2 (a leaf/inline value gains its first field there — an omni node).
    let childIndent = indent + 2;
    for (let i = bodyLo; i < bodyHi; i++) {
      if (isContentLine(lines[i]) && indentOf(lines[i]) > indent) { childIndent = indentOf(lines[i]); break; }
    }
    void inline;
    lo = bodyLo; hi = bodyHi; indent = childIndent;
  }
  return { lo, hi, indent };
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
      if (t === "-" || t.startsWith("- ")) { items.push(i); end = i; continue; }
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
  const region = reachBody(lines, within);
  const seq = seqItemLines(lines, region, ANNOTATIONS_KEY);
  if (!seq) {
    const at = trimBack(lines, region.lo - 1, region.hi);
    lines.splice(at, 0, `${" ".repeat(region.indent)}${ANNOTATIONS_KEY}:`, ...render(region.indent));
  } else {
    lines.splice(seq.end, 0, ...render(region.indent));
  }
  return lines.join("\n") + "\n";
}

/** Upsert an `<entryKey>:` entry into the `<mapKey>:` mapping of the node addressed by `within`,
 *  creating the map key (and any missing path) if absent. `render(indent)` returns the entry's
 *  source lines INCLUDING the `<entryKey>:` line, at the mapping's child indent. An entry whose key
 *  already exists is REPLACED (its whole block). The shared engine behind {@link upsertFragment}
 *  and {@link upsertThumbnail}. */
function upsertMapEntry(text: string, within: string[], mapKey: string, entryKey: string, render: (indent: number) => string[]): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = reachBody(lines, within);
  let mapLine = findKeyLine(lines, region.lo, region.hi, region.indent, mapKey);
  if (mapLine < 0) {
    const at = trimBack(lines, region.lo - 1, region.hi);
    lines.splice(at, 0, `${" ".repeat(region.indent)}${keyToken(mapKey)}:`);
    mapLine = at;
  }
  const mapIndent = region.indent + 2;
  const mapBody: Region = { lo: mapLine + 1, hi: blockEnd(lines, mapLine + 1, lines.length, region.indent + 1), indent: mapIndent };
  const existing = findKeyLine(lines, mapBody.lo, mapBody.hi, mapIndent, entryKey);
  if (existing >= 0) {
    const end = blockEnd(lines, existing + 1, mapBody.hi, mapIndent + 1);
    lines.splice(existing, end - existing, ...render(mapIndent));
  } else {
    const at = trimBack(lines, mapLine, mapBody.hi);
    lines.splice(at, 0, ...render(mapIndent));
  }
  return lines.join("\n") + "\n";
}

/** Upsert a `<slug>:` entry into the `yamlover-fragments:` mapping of the node addressed by
 *  `within`, creating the key (and any missing path) if absent. `render(indent)` returns the
 *  fragment's source lines INCLUDING the `<slug>:` line, at the mapping's child indent. A slug
 *  that already exists is REPLACED (its whole block). */
export function upsertFragment(text: string, within: string[], slug: string, render: (indent: number) => string[]): string {
  return upsertMapEntry(text, within, FRAGMENTS_KEY, slug, render);
}

/** Upsert a `[w, h]:` entry into the `yamlover-thumbnails:` mapping of the node addressed by
 *  `within` (an omni overlay on the original blob — parallel to `yamlover-fragments`), creating
 *  the key (and any missing path) if absent. `render(indent)` returns the entry's source line
 *  INCLUDING the resolution key. The same `[w, h]` resolution is REPLACED if already present. */
export function upsertThumbnail(text: string, within: string[], resKey: string, render: (indent: number) => string[]): string {
  return upsertMapEntry(text, within, THUMBNAILS_KEY, resKey, render);
}

/** Remove an annotation element from the `yamlover-annotations:` of the node at `within` — the
 *  first `- ` item whose trimmed text matches `predicate`. Returns the text unchanged if none
 *  matches. The block of a multi-line object item is removed whole. */
export function removeAnnotation(text: string, within: string[], predicate: (itemText: string) => boolean): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const region = reachBody(lines, within);
  const seq = seqItemLines(lines, region, ANNOTATIONS_KEY);
  if (!seq) return text;
  for (let k = 0; k < seq.items.length; k++) {
    const i = seq.items[k];
    const itemText = lines[i].trim().replace(/^-\s*/, "");
    if (!predicate(itemText)) continue;
    const next = k + 1 < seq.items.length ? seq.items[k + 1] : seq.end;
    lines.splice(i, next - i);
    return lines.join("\n") + "\n";
  }
  return text;
}
