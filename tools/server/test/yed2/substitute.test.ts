// yed2 — REQUIREMENT 8: the RECURSIVE SUBSTITUTION suite. For every pair (e1, e2) from the
// expression set E: enter e1 by keystrokes, enumerate its subexpression sites from the IR, and at
// EVERY site delete the subexpression in place (a scoped, jam-detected Backspace ladder) and type
// e2 into the hole it leaves; the result must be IR-equal to the direct splice. Containers also
// take e2 APPENDED as a new element. Pure — no DOM; cursor placement stands in for a click, every
// edit is a keystroke through the same applyKey the page runs.
import { describe, it, expect } from "vitest";
import { applyKey } from "../../src/client/yed2/apply";
import {
  entryAt, initialState, isFlow, bracketOf, nodeAt, parseSource, sourceOf,
  type Cursor, type EditorState, type Node, type Path,
} from "../../src/client/yed2/state";
import { parseScript } from "./keys-util";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { canonDoc } from "../../../parser/ts/src/canon.ts";
import { isPointer, type Entry } from "../../../parser/ts/src/ir.ts";

/** E — each expression as source text AND as the keystroke script that enters it ({ escaped). */
const E = [
  { src: "12", script: "12" },
  { src: "ab", script: "ab" },
  { src: "{}", script: "{{}" },
  { src: "[]", script: "[]" },
  { src: "{a: 1}", script: "{{a: 1}" },
  { src: "[1, 2]", script: "[1, 2]" },
  { src: "[1, {a: 1}]", script: "[1, {{a: 1}]" },
];

function type(script: string, from: EditorState = initialState()): EditorState {
  let s = from;
  for (const k of parseScript(script)) s = applyKey(s, "ch" in k ? { key: k.ch } : k);
  return s;
}

/** Every VALUE site of the document: the root, then each entry's value, recursively. */
function valuePaths(root: Node): Path[] {
  const out: Path[] = [[]];
  const rec = (n: Node, p: Path): void => {
    (n.entries ?? []).forEach((e, i) => {
      if (isPointer(e.value)) return;
      out.push([...p, i]);
      rec(e.value as Node, [...p, i]);
    });
  };
  rec(root, []);
  return out;
}

const canon = (doc: EditorState["doc"]): string => {
  const src = sourceOf(doc);
  return JSON.stringify(canonDoc(parseYamlover(src === "" ? "{}" : src, "<canon>")));
};

/** The direct splice — the substitution the keystrokes must reproduce. */
function splice(root: Node, p: Path, v: Node): Node {
  if (p.length === 0) return v;
  const entries = [...(root.entries ?? [])];
  entries[p[0]] = { ...entries[p[0]], value: splice(entries[p[0]].value as Node, p.slice(1), v) } as Entry;
  return { ...root, entries } as Node;
}

/** Backspace until the whole DOCUMENT is empty (the root site's delete-in-place). */
function unwindRoot(s: EditorState): EditorState {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    if (sourceOf(s.doc) === "" && s.cursor.at === "hole" && s.cursor.path.length === 0 && s.cursor.text === "") return s;
    const st = JSON.stringify([sourceOf(s.doc), s.cursor]);
    expect(seen.has(st), `JAMMED unwinding the root at ${st}`).toBe(false);
    seen.add(st);
    if ("text" in s.cursor && s.cursor.text !== "") s = { ...s, cursor: { ...s.cursor, text: "" } } as EditorState;
    else s = applyKey(s, { key: "Backspace" });
  }
  expect.fail(`the root did not unwind in 200 steps — at ${JSON.stringify(sourceOf(s.doc))}`);
}

/** Delete the ENTRY at `entryPath` in place: aim the caret inside its subtree (a click), then a
 *  scoped Backspace ladder until the parent has one entry fewer. Leaves the hole at the site. */
function deleteEntry(state: EditorState, entryPath: Path): EditorState {
  const parentPath = entryPath.slice(0, -1);
  const before = (nodeAt(state.doc, parentPath)?.entries ?? []).length;
  const v = entryAt(state.doc, entryPath)!.value as Node;
  const cursor: Cursor = v.kind === "scalar" && (v.entries ?? []).length === 0
    ? { at: "token", path: entryPath, text: String((v as { raw?: string }).raw ?? (v as { value?: unknown }).value ?? "") }
    : { at: "hole", path: entryPath, index: (v.entries ?? []).length, text: "", key: null };
  let s: EditorState = { ...state, cursor, refused: false };
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    // deletion is done when the parent shrank AND the hole is fully undecided — a keyed entry's
    // name survives its value's removal (committed labour) and costs its own presses to unwind
    if ((nodeAt(s.doc, parentPath)?.entries ?? []).length === before - 1
      && s.cursor.at === "hole" && s.cursor.text === "" && s.cursor.key === null && s.cursor.ordinal !== true) {
      // …and the ladder must leave the caret AT the vacated site, ready to take e2
      expect(s.cursor).toEqual({ at: "hole", path: parentPath, index: entryPath[entryPath.length - 1], text: "", key: null });
      return s;
    }
    const st = JSON.stringify([sourceOf(s.doc), s.cursor]);
    expect(seen.has(st), `JAMMED deleting ${entryPath.join("/")} at ${st}`).toBe(false);
    seen.add(st);
    if ("text" in s.cursor && s.cursor.text !== "") s = { ...s, cursor: { ...s.cursor, text: "" } } as EditorState;
    else s = applyKey(s, { key: "Backspace" });
  }
  expect.fail(`entry ${entryPath.join("/")} did not delete in 200 steps — at ${JSON.stringify(sourceOf(s.doc))}`);
}

describe("yed2 substitution — every e2 at every site of every e1", () => {
  for (const e1 of E) {
    const base = type(e1.script + "{ArrowRight}");
    const baseIR = parseSource(e1.src);
    const sites = valuePaths(baseIR.root as Node);

    for (const e2 of E) {
      it(`${e1.src} ⇐ ${e2.src} — REPLACED at ${sites.length} site(s)`, () => {
        for (const p of sites) {
          let s: EditorState;
          let keyPrefix = "";
          if (p.length === 0) {
            s = unwindRoot(base);
          } else {
            const key = entryAt(baseIR, p)?.key ?? null;
            keyPrefix = key !== null ? `${key}: ` : "";
            s = deleteEntry(base, p);
          }
          s = type(keyPrefix + e2.script + "{ArrowRight}", s);
          // (the trailing ArrowRight may hit the document's edge and refuse — a visible edge
          // ring, not a failure; the IR equality below is the real gate)
          const want = { ...baseIR, root: splice(baseIR.root as Node, p, parseSource(e2.src).root as Node) };
          expect(canon(s.doc), `at site ${p.join("/")} of ${e1.src}`).toBe(canon(want));
        }
      });

      it(`${e1.src} ⇐ ${e2.src} — APPENDED in every container`, () => {
        for (const p of sites) {
          const target = p.length === 0 ? (baseIR.root as Node) : (entryAt(baseIR, p)!.value as Node);
          if (target.kind === "scalar" || !isFlow(target)) continue;
          const len = (target.entries ?? []).length;
          // the caret lands in the container's LAST hole (a click on its closing gap)
          let s: EditorState = { ...base, cursor: { at: "hole", path: p, index: len, text: "", key: null }, refused: false };
          const keyPrefix = bracketOf(target) === "{" ? "z: " : "";
          s = type(keyPrefix + e2.script + "{ArrowRight}", s);
          const appended: Node = {
            ...target,
            entries: [...(target.entries ?? []), { key: keyPrefix === "" ? null : "z", edge: "contain", value: parseSource(e2.src).root } as unknown as Entry],
          } as Node;
          const want = { ...baseIR, root: splice(baseIR.root as Node, p, appended) };
          expect(canon(s.doc), `appended in ${p.join("/")} of ${e1.src}`).toBe(canon(want));
        }
      });
    }
  }
});
