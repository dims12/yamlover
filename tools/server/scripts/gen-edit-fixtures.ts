// Generate the `edit-examples/` corpus from the documents the project already contains.
//
// One fixture per typeable source: a keystroke script that a person would use to enter that
// document, plus `from` so the harness knows what the result must reparse to. Goldens are
// GENERATED, REVIEWED and COMMITTED (the discipline of gen-fixtures.ts); the harness only READS.
//
// THE DERIVATION follows THE LEVEL RULE (docs/server/yamlover-editor - THE LEVEL RULE): Enter after
// committing a value DESCENDS into it, so staying at the same level costs one Shift-Tab and every
// step outwards costs another. That is the whole model — line text, `{Enter}`, then as many
// `{ShiftTab}`s as it takes to reach the next line's depth.
//
// What it cannot express it SKIPS, with the reason recorded in edit-examples/SKIPPED.md, so the
// corpus's coverage is reviewable instead of quietly partial.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const CORPUS = join(REPO, "edit-examples");
/** Generated ids start here; 0001–0099 are hand-written. */
const FIRST_GENERATED = 100;

// --------------------------------------------------------------------------- //
// Sources
// --------------------------------------------------------------------------- //

/** Every candidate document, as a repo-relative path, in a stable order. */
function sources(): string[] {
  const out: string[] = [];
  const ex = join(REPO, "examples");
  for (const name of readdirSync(ex).sort()) {
    const abs = join(ex, name);
    if (statSync(abs).isDirectory()) {
      const body = join(abs, ".yo", "body.yo");
      if (existsSync(body)) out.push(relative(REPO, body));
    } else if (name.endsWith(".yo")) {
      out.push(relative(REPO, abs));
    }
  }
  const te = join(REPO, "test-examples");
  for (const id of readdirSync(te).sort()) {
    const dir = join(te, id);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "error"))) continue; // an error fixture is not typeable by definition
    const inp = join(dir, "in.yo");
    if (existsSync(inp)) out.push(relative(REPO, inp));
  }
  return out.map((p) => p.split("\\").join("/"));
}

// --------------------------------------------------------------------------- //
// Derivation
// --------------------------------------------------------------------------- //

type Derived = { keys: string } | { skip: string };

/** A trailing `  # …` comment is dropped: comments are not part of IR identity (canon.ts ignores
 *  them), and typing one would land inside the value cell.
 *
 *  QUOTE-AWARE, because a `#` inside quotes is data — `single: 'a # b'` is one scalar, and a naive
 *  `/\s+#/` cut it to `single: 'a`, generating a fixture that tested nothing but the generator's
 *  own bug. Mirrors the parser's rule: `''` doubles inside single quotes, `\` escapes inside double. */
function stripTrailingComment(t: string): string {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (q === '"' && c === "\\") { i++; continue; }
      if (c === q) { if (q === "'" && t[i + 1] === "'") i++; else q = null; }
      continue;
    }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && i > 0 && /\s/.test(t[i - 1])) return t.slice(0, i).trimEnd();
  }
  return t;
}

/** `{` is the script's escape character. */
const literal = (t: string): string => t.split("{").join("{{");

interface Row {
  /** the source's indent / 2 */
  textual: number;
  /** the depth in the TREE — see the same-indent sequence note below */
  logical: number;
  text: string;
  dash: boolean;
  /** a `key:` with nothing after the colon: the next row may be its child */
  bareKey: boolean;
  /** how many tree levels this ONE row opens — 2 for a compact `- key: …` (the element AND its
   *  key), so Enter lands two levels inside it. See the climb arithmetic below. */
  levels: number;
}

/** A compact keyed element (`- name: Rex`): the dash opens the element and the `key:` opens a field
 *  inside it, both on one row. The caret finishes inside the KEY, so Enter descends to the key's
 *  children — one level deeper than a plain `- value` row. Without counting that, a following
 *  SIBLING field (`species: dog`) was scripted with no Shift-Tab and became the key's child. */
const COMPACT_KEYED = /^-\s+[^\s#"'*|>[{&!-][^:]*:(\s|$)/;

/** A row's parent: the nearest preceding row that ENCLOSES it. Normally that is the last row at a
 *  shallower indent — but yamlover also lets a sequence sit at the SAME indent as its key
 *  (`pets:` then `- a` in column 0), and there the dash rows are the key's CHILDREN. Getting this
 *  wrong costs a Shift-Tab in the script and silently produces a sibling instead of a child. */
function parentOf(rows: Row[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j].textual < rows[i].textual) return j;
    if (rows[j].textual === rows[i].textual && rows[j].bareKey && rows[i].dash) return j;
  }
  return -1;
}

function derive(src: string): Derived {
  if (/^---/m.test(src)) return { skip: "multi-document (`---`) — out of scope" };
  // own-line `&: …` AND inline `&body value` alike: `&` in a value cell now OPENS the bookmark
  // face (bookmarks are entered, not spelled), so the inline anchor+value one-liner is not a
  // typeable line of text any more
  if (/(^|\s)&/m.test(src)) return { skip: "a `&` path anchor — `&` opens the bookmark face; the inline spelling is not typeable" };
  if (/^\s*~[^\s]/m.test(src) || /^\s*~-/m.test(src)) return { skip: "a `~` back-edge — no cell types one, and it IS part of IR identity" };
  if (/(^|\s)[|>][+-]?\d*\s*$/m.test(src)) return { skip: "a block scalar — its cell is a textarea, finished by Shift-Tab, not a line of text" };
  // A `*` pointer opens the shared QUERY cell, whose value is accepted through its completion
  // popup — typing the raw text and blurring commits nothing (verified: the document comes out
  // empty). A keystroke script cannot drive that today.
  if (/(^|\s)\*/m.test(src)) return { skip: "a `*` pointer — its cell commits through the completion popup, not a blur" };
  // `!!<…>` and the shape tags need the tag cell, which `!!<` opens but whose content a plain
  // line of text does not finish.
  if (/!!</.test(src)) return { skip: "a `!!<…>` schema tag — its content lives in the tag cell" };
  if (/!!(set|mix|var|omni)\b/.test(src)) return { skip: "a `!!set`/`!!var`/`!!mix` shape tag — no cell types one" };
  // A COMPACT dash chain (`- - - x`) puts three tree levels on one row, so the derivation's
  // "one row is one level" arithmetic cannot place the rows that follow. A limit of this generator,
  // not of the editor — typing `- - x` does nest correctly.
  if (/^\s*-\s+-/m.test(src)) return { skip: "a compact `- - ` dash chain — several tree levels on one row" };
  // A quote cell edits the DECODED text, so typing `\` `n` means a literal backslash-n — correct
  // for a person, but it cannot reproduce a source whose `"…\n…"` means a real newline. Verified:
  // `s: "line one\nline two"` typed character by character yields `s: "line one\\nline two"`.
  if (/\\/.test(src)) return { skip: "a backslash escape in a quoted string — the quote cell edits DECODED text" };

  const rows: Row[] = [];
  for (const raw of src.split("\n")) {
    const t0 = raw.trim();
    if (t0 === "" || t0.startsWith("#")) continue; // blanks and comments: not IR identity
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) return { skip: `an odd indent (${indent}) — the editor's step is 2` };
    const text = stripTrailingComment(t0);
    rows.push({
      textual: indent / 2, logical: 0, text,
      dash: text === "-" || text.startsWith("- "),
      bareKey: /^[^\s#][^:]*:$/.test(text),
      levels: COMPACT_KEYED.test(text) ? 2 : 1,
    });
  }
  if (rows.length === 0) return { skip: "no content lines" };
  if (rows[0].textual !== 0) return { skip: "the first content line is indented" };
  for (let i = 0; i < rows.length; i++) {
    const p = parentOf(rows, i);
    rows[i].logical = p < 0 ? 0 : rows[p].logical + 1;
  }

  const out: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(literal(rows[i].text));
    const next = rows[i + 1];
    if (!next) break;
    out.push("{Enter}");
    // THE LEVEL RULE: Enter landed us INSIDE this row (one level, or two for a compact `- key: …`);
    // climb until we are at `next`'s
    const climbs = rows[i].logical + rows[i].levels - next.logical;
    if (climbs < 0) return { skip: `an indent jump of ${-climbs} levels at line ${i + 2} — one Enter descends one level` };
    out.push("{ShiftTab}".repeat(climbs));
  }
  out.push("{Blur}");
  return { keys: out.join("") };
}

// --------------------------------------------------------------------------- //
// Write
// --------------------------------------------------------------------------- //

const FIXTURE_ID = /^\d{4}(-\d{2})?$/;

/** Clear the previously GENERATED fixtures (those carrying a `from`), leaving hand-written ones. */
function clearGenerated(): void {
  if (!existsSync(CORPUS)) mkdirSync(CORPUS, { recursive: true });
  for (const id of readdirSync(CORPUS)) {
    const dir = join(CORPUS, id);
    if (!FIXTURE_ID.test(id) || !statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "from"))) rmSync(dir, { recursive: true, force: true });
  }
}

clearGenerated();

const skipped: { from: string; why: string }[] = [];
let n = FIRST_GENERATED;
let written = 0;
for (const from of sources()) {
  const src = readFileSync(join(REPO, from), "utf8");
  const d = derive(src);
  if ("skip" in d) {
    skipped.push({ from, why: d.skip });
    continue;
  }
  const id = String(n++).padStart(4, "0");
  const dir = join(CORPUS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "==="), `typed from ${from}\n`);
  writeFileSync(join(dir, "keys"), d.keys);
  writeFileSync(join(dir, "from"), `${from}\n`);
  writeFileSync(join(dir, "expect"), "roundtrip\n");
  written++;
}

const lines = [
  "# Sources the generator could not turn into a keystroke sequence",
  "",
  "Written by `npm run gen:edit-fixtures`. A skip is a statement about the EDITOR's typing grammar,",
  "not about the document: every entry here is a shape a person cannot currently type. Shrinking this",
  "list is a feature request; the corpus's honesty depends on it being complete.",
  "",
  `${skipped.length} of ${skipped.length + written} sources skipped.`,
  "",
];
const byWhy = new Map<string, string[]>();
for (const s of skipped) byWhy.set(s.why, [...(byWhy.get(s.why) ?? []), s.from]);
for (const [why, froms] of [...byWhy.entries()].sort()) {
  lines.push(`## ${why}`, "");
  for (const f of froms.sort()) lines.push(`- \`${f}\``);
  lines.push("");
}
writeFileSync(join(CORPUS, "SKIPPED.md"), lines.join("\n"));

console.log(`gen-edit-fixtures: ${written} fixture(s) written, ${skipped.length} source(s) skipped`);
