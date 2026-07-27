// yed2 — REQUIREMENT 9: every corpus sample is ENTERABLE and then DELETABLE. Pure — the whole
// corpus replays through the keystroke simulator with no DOM, and every entered document then
// rides the Backspace ladder to the empty document under the jam detector.
//
// THE ALLOWLIST is honest in both directions (the conformance pattern): a listed fixture must
// still fail — fixing its cause tells you exactly which entries to delete — and it only shrinks.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { applyKey, watchdog } from "../../src/client/yed2/apply";
import { initialState, parseSource, sourceOf, type EditorState } from "../../src/client/yed2/state";
import { parseScript } from "./keys-util";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { canonDoc } from "../../../parser/ts/src/canon.ts";
import { isPointer, type Node, type Value } from "../../../parser/ts/src/ir.ts";

const REPO = path.resolve(__dirname, "../../../..");
const CORPUS = path.join(REPO, "edit-examples");
const FIXTURE_ID = /^\d{4}(-\d{2})?$/;

// --- the defect inventory: what yed2 cannot do YET, by cause. THE LIST ONLY SHRINKS. -----------
const ENTER_ALLOW = new Map<string, string>([
  ["0012", "token-as-key (`{}: 12`) — the tokenKey intent is not implemented yet"],
]);
const DELETE_ALLOW = new Map<string, string>([]);

// BYTES fixtures whose content enters IR-EQUAL but whose SPELLING drifts — each drift named.
// The goldens were written by the server's text-splicing path, which preserves authored spelling
// where the pure serializer normalizes (quoting and null spellings are REPRESENTATION). The list
// shrinks as serializer fidelity lands; a fixture that becomes byte-exact must be delisted.
const SPELLING_DRIFT = new Map<string, string>([
  ["0001", "null spells `~` in the golden, bare after the key here"],
  ["0002", "authored quoted keys; nulls as above"],
  ["0010", 'the authored quoted key `"a"` normalizes to bare'],
  ["0014", "the golden pins the OLD whole-token spread; per-container layout keeps the inner tight"],
]);

interface Fixture { id: string; keys: string; input?: string; expect: "roundtrip" | "bytes"; out?: string; from?: string }

function loadFixture(id: string): Fixture {
  const dir = path.join(CORPUS, id);
  const read = (n: string): string | undefined => (fs.existsSync(path.join(dir, n)) ? fs.readFileSync(path.join(dir, n), "utf8") : undefined);
  return {
    id,
    keys: read("keys") ?? "",
    input: read("in.yamlover"),
    expect: (read("expect") ?? "roundtrip").trim() as "roundtrip" | "bytes",
    out: read("out.yamlover"),
    from: read("from")?.trim(),
  };
}

const ids = fs.readdirSync(CORPUS).filter((n) => FIXTURE_ID.test(n) && fs.statSync(path.join(CORPUS, n)).isDirectory()).sort();

/** Replay a fixture's keys from its starting document. `{Blur}` commits pending content the way a
 *  real blur does — via the move-free commit boundary (Enter would add structure, so it maps to a
 *  bare commitPending through a right-move to the same slot; simplest honest form: ArrowRight,
 *  which commits or refuses). */
function enter(f: Fixture): { state: EditorState; failure: string | null } {
  let state: EditorState = f.input !== undefined && f.input.trim() !== ""
    ? { doc: parseSource(f.input), cursor: { at: "hole", path: [], index: 0, text: "", key: null }, refused: false, log: [] }
    : initialState();
  try {
    for (const k of parseScript(f.keys.replace(/\{Blur\}/g, "{ArrowRight}"))) {
      state = applyKey(state, "ch" in k ? { key: k.ch } : k);
    }
  } catch (e) {
    return { state, failure: `replay threw: ${(e as Error).message}` };
  }
  const got = sourceOf(state.doc);
  if (f.expect === "bytes") {
    if (got === (f.out ?? "")) {
      if (SPELLING_DRIFT.has(f.id)) return { state, failure: "now BYTE-EXACT — remove from SPELLING_DRIFT" };
      return { state, failure: null };
    }
    // an allowed spelling drift still requires IR EQUALITY — the CONTENT must be exactly right
    if (SPELLING_DRIFT.has(f.id)) {
      try {
        const a = canonDoc(parseYamlover(got === "" ? "{}" : got, "<got>"));
        const b = canonDoc(parseYamlover(f.out ?? "", "<want>"));
        if (JSON.stringify(a) === JSON.stringify(b)) return { state, failure: null };
      } catch { /* fall through to the bytes failure */ }
    }
    return { state, failure: `bytes differ\n  want ${JSON.stringify(f.out)}\n  got  ${JSON.stringify(got)}` };
  }
  const want = f.from !== undefined ? fs.readFileSync(path.join(REPO, f.from), "utf8") : (f.out ?? "");
  try {
    const a = canonDoc(parseYamlover(got === "" ? "{}" : got, "<got>"));
    const b = canonDoc(parseYamlover(want, "<want>"));
    if (JSON.stringify(a) !== JSON.stringify(b)) return { state, failure: `IR differs\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}` };
  } catch (e) {
    return { state, failure: `reparse failed: ${(e as Error).message}\n  got ${JSON.stringify(got)}` };
  }
  return { state, failure: null };
}

/** The Backspace ladder to the empty document — the jam detector fails at the exact repeat. */
function unwind(s: EditorState, maxSteps = 400): string | null {
  const seen = new Set<string>();
  for (let i = 0; i < maxSteps; i++) {
    if (sourceOf(s.doc) === "" && s.cursor.at === "hole" && s.cursor.path.length === 0 && s.cursor.text === "") return null;
    const key = JSON.stringify([sourceOf(s.doc), s.cursor]);
    if (seen.has(key)) return `JAMMED after ${i} steps at ${key.slice(0, 160)}`;
    seen.add(key);
    if ("text" in s.cursor && s.cursor.text !== "") { s = { ...s, cursor: { ...s.cursor, text: "" } } as EditorState; continue; }
    s = applyKey(s, { key: "Backspace" });
  }
  return `did not reach the empty document in ${maxSteps} steps — at ${JSON.stringify(sourceOf(s.doc)).slice(0, 160)}`;
}

/** Constructs yed2's pure layer does not model yet — a LOADED document containing one is skipped
 *  from the delete ladder EXPLICITLY, with the construct named (never silently). */
function unsupportedIn(doc: { root: Value }): string | null {
  const walk = (v: Value): string | null => {
    if (isPointer(v)) return null; // pointer ATOMS are modeled: walkable, deletable
    const n = v as Node;
    if (n.kind === "blob") return "a blob";
    if (n.meta?.schema !== undefined) return "a `!!<…>` schema tag";
    if ((n.meta as { set?: boolean } | undefined)?.set) return "`!!set`";
    if ((n.meta?.anchors ?? []).length > 0) return "a `&` path anchor";
    for (const e of n.entries ?? []) {
      if (e.edge === "back") return "a `~` back-edge";
      const r = walk(e.value);
      if (r) return r;
    }
    return null;
  };
  return walk(doc.root);
}

describe("yed2 corpus — every sample enterable, then deletable", () => {
  for (const id of ids) {
    const f = loadFixture(id);
    const enterKnown = ENTER_ALLOW.get(id);
    it(`${id} enters${enterKnown ? " [known-failing]" : ""}`, () => {
      const { state, failure } = enter(f);
      if (enterKnown) expect(failure, `${id} now ENTERS — remove it from ENTER_ALLOW (was: ${enterKnown})`).not.toBeNull();
      else {
        expect(failure, `${id}\n${failure}`).toBeNull();
        watchdog(state); // the entered state may hold no dead advertised key
      }
    });
    if (!enterKnown) {
      const delKnown = DELETE_ALLOW.get(id);
      it(`${id} deletes to empty${delKnown ? " [known-failing]" : ""}`, () => {
        const { state, failure } = enter(f);
        expect(failure).toBeNull();
        const jam = unwind(state);
        if (delKnown) expect(jam, `${id} now DELETES — remove it from DELETE_ALLOW (was: ${delKnown})`).not.toBeNull();
        else expect(jam, `${id}\n${jam}`).toBeNull();
      });
    }
  }

  it("the allowlists reference only real fixtures", () => {
    const known = new Set(ids);
    const stale = [...ENTER_ALLOW.keys(), ...DELETE_ALLOW.keys(), ...SPELLING_DRIFT.keys()].filter((k) => !known.has(k));
    expect(stale, `stale allowlist ids: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("yed2 corpus — every LOADED test-example deletable (or its blocker NAMED)", () => {
  const TE = path.join(REPO, "test-examples");
  const teIds = fs.readdirSync(TE).filter((n) => /^\d{4}(-\d{2})?$/.test(n) && fs.existsSync(path.join(TE, n, "in.yamlover")));
  const LOAD_DELETE_ALLOW = new Map<string, string>([]);
  const skipped: string[] = [];

  for (const id of teIds) {
    const src = fs.readFileSync(path.join(TE, id, "in.yamlover"), "utf8");
    let doc;
    try { doc = parseSource(src); } catch { continue; } // error fixtures are not documents
    const blocker = unsupportedIn(doc);
    if (blocker) { skipped.push(`${id}: ${blocker}`); continue; }
    const known = LOAD_DELETE_ALLOW.get(id);
    it(`test-examples/${id} loads and deletes to empty${known ? " [known-failing]" : ""}`, () => {
      const state: EditorState = { doc: parseSource(src), cursor: { at: "hole", path: [], index: 0, text: "", key: null }, refused: false, log: [] };
      const jam = unwind(state);
      if (known) expect(jam, `${id} now deletes — delist`).not.toBeNull();
      else expect(jam, `${id}\n${jam}`).toBeNull();
    });
  }

  it(`skips are EXPLICIT and named (${skipped.length} documents carry constructs yed2 does not model yet)`, () => {
    // the honest ledger — shrink it by implementing the constructs (pointers, anchors, tags, omni)
    expect(skipped.length).toBeGreaterThan(0);
  });
});
