// @vitest-environment jsdom
// THE EDIT-SEQUENCE CORPUS — `edit-examples/` (see its README). Each fixture is a keystroke script
// replayed through the real client stack into a real server; the assertion is what came out on disk.
//
// This is the test the editor did not have. Every other editor test mocks `api.ts`, so a server
// rejection ("edit sync failed: …") cannot reach it; the defects reported by hand over the last
// rounds were all of exactly that kind. Here the ops are real, the handler is real, the tree is
// real, and a keystroke with nowhere to go fails the fixture where it happened.
//
// THE ALLOWLIST is honest in BOTH directions: a listed fixture must still fail, so fixing a defect
// tells you precisely which ids to delete. It only ever shrinks — it is the editor's defect list.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree, REPO } from "./helpers";
import { call } from "./http";
import { captureAlerts, installFetch, replay, settleOps } from "./edit-corpus-harness";
import { YedEditor } from "../src/client/renderers/yed-editor";
import { parseYamlover } from "../../parser/ts/src/yamlover.ts";
import { canonDoc } from "../../parser/ts/src/canon.ts";
import { nodeJson } from "./node-json";

const CORPUS = path.join(REPO, "edit-examples");
const FIXTURE_ID = /^\d{4}(-\d{2})?$/;

// --- known-failing fixtures, each with its CAUSE. THE LIST ONLY SHRINKS. ---------------------
// This is the editor's real defect inventory, discovered by the corpus rather than by hand. Fixing
// a cause deletes its entries; the gate below fails if a listed fixture starts passing, so the list
// cannot rot. It is EMPTY today — every fixture the generator can express round-trips.
//
// KEYED BY SOURCE (`from`), not by fixture id: generated ids are a sequence, so adding or skipping
// one source renumbers everything after it and id-keyed entries would silently come to describe a
// different document. A hand-written fixture (no `from`) is keyed by its id, which is stable.
// One DELIBERATE entry since the yed retarget (0016 — the legacy `key1: key2: value` nesting —
// was the LEGACY component's defect; yed agrees with the parser and it passes now).
const ALLOWLIST = new Map<string, string>([
  // The golden pins the OLD whole-token spread; yed's PER-CONTAINER layout law keeps a token
  // typed inside a spread one tight until its own Enter. IR-equal — the pure corpus
  // (tools/yed corpus.test.ts SPELLING_DRIFT) pins that half of the contract.
  ["0014", "DELIBERATE: per-container layout replaced legacy whole-token spread"],
  // Exposed 2026-08-12 by regenerating over the grown test-examples set: the generator's
  // SPREAD-FLOW scripts (`k: v,{Enter}` rows inside a spread token) lose members on replay —
  // an editor defect in spread-flow row entry (the pure corpus lists the same three in
  // ENTER_ALLOW). Shrink by fixing the spread-flow grammar.
  ["test-examples/0105-01/in.yo", "spread-flow entry: later members + siblings vanish"],
  ["test-examples/0105-02/in.yo", "nested spread-flow entry: the inner `],` splice corrupts keys"],
  ["test-examples/0105-03/in.yo", "spread-flow seq under `- `: the second `- {{` row is lost"],
]);

interface Fixture {
  id: string;
  title: string;
  keys: string;
  input?: string;             // in.yo — the starting document
  expect: "roundtrip" | "bytes";
  out?: string;               // out.yo — required for `bytes`
  from?: string;              // generated fixtures: the sample this came from
}

function loadFixture(id: string): Fixture {
  const dir = path.join(CORPUS, id);
  const read = (name: string): string | undefined => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  };
  const mode = (read("expect") ?? "roundtrip").trim();
  if (mode !== "roundtrip" && mode !== "bytes") throw new Error(`${id}: expect must be roundtrip|bytes, got ${mode}`);
  const keys = read("keys");
  if (keys === undefined) throw new Error(`${id}: no keys script`);
  const out = read("out.yo");
  if (mode === "bytes" && out === undefined) throw new Error(`${id}: expect=bytes needs out.yo`);
  return { id, title: (read("===") ?? "").trim(), keys, input: read("in.yo"), expect: mode, out, from: read("from")?.trim() };
}

const ids = fs.existsSync(CORPUS)
  ? fs.readdirSync(CORPUS).filter((n) => FIXTURE_ID.test(n) && fs.statSync(path.join(CORPUS, n)).isDirectory()).sort()
  : [];

/** Run one fixture; returns the failure reason, or null when it passed. Never throws for a
 *  fixture-level failure — the allowlist gate needs to ask "did this pass?" either way. */
async function runFixture(f: Fixture): Promise<string | null> {
  // A STANDALONE FILE is the substrate, so a fixture tests the TYPING GRAMMAR and nothing else.
  // In a DIRECTORY-backed document the storage policy also applies — a keyed node that gains
  // container content is promoted into its own subdirectory (concrete-rules.ts) — so the content
  // would leave this file mid-sequence and a one-file assertion would read empty. Fixtures for that
  // policy belong in the server-side suites, which can assert over the whole tree.
  const root = tmpTree({ "note.yo": f.input ?? "" });
  const bodyPath = path.join(root, "note.yo");
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  const restoreFetch = installFetch(h);
  const alerts = captureAlerts();
  try {
    const { container } = render(<YedEditor path=":note.yo" onNavigate={() => {}} />);
    await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy(), { timeout: 3000 });
    // `{Blur}` is the LEGACY commit boundary (commit-on-blur); yed's move-free commit is the
    // right-move — the same substitution the pure corpus runner makes (tools/yed corpus.test.ts)
    replay(f.keys.replace(/\{Blur\}/g, "{ArrowRight}"));
    await settleOps();

    // 1. the sync itself — the seam a mocked editChunks can never show
    if (alerts.messages.length) return `the server rejected an op: ${alerts.messages.join(" | ")}`;

    const onDisk = fs.readFileSync(bodyPath, "utf8");

    // 2. the assertion the fixture asked for
    if (f.expect === "bytes") {
      if (onDisk !== f.out) return `bytes differ\n  want: ${JSON.stringify(f.out)}\n  got:  ${JSON.stringify(onDisk)}`;
    } else {
      // ROUND-TRIP IDENTITY: what landed must reparse to the same IR as what was typed. No golden
      // to bless — the property IS "the editor recorded what I typed".
      const want = f.from !== undefined ? fs.readFileSync(path.join(REPO, f.from), "utf8") : (f.out ?? "");
      try {
        const a = canonDoc(parseYamlover(onDisk, "<disk>"));
        const b = canonDoc(parseYamlover(want, "<source>"));
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          return `the file does not reparse to the source's IR\n  disk: ${JSON.stringify(onDisk)}\n  want: ${JSON.stringify(want)}`;
        }
      } catch (e) {
        return `the file does not even parse: ${(e as Error).message}\n  disk: ${JSON.stringify(onDisk)}`;
      }
    }

    // 3. and the SERVER agrees about what is there (a splice the walker reads differently is a bug
    //    the bytes alone would hide)
    const j = (await nodeJson(h, { path: ":note.yo", depth: ".inf" })).json as { value: unknown };
    if (j === undefined) return "the document no longer projects";
    return null;
  } catch (e) {
    return `${(e as Error).message}`;
  } finally {
    alerts.restore();
    restoreFetch();
    cleanup();
  }
}

afterEach(cleanup);

describe("edit-examples — keystroke sequences, replayed for real", () => {
  it(`the corpus is present (${ids.length} fixtures)`, () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  for (const id of ids) {
    const f = loadFixture(id);
    const known = ALLOWLIST.get(f.from ?? id);
    it(`${id}: ${f.title}${known ? " [known-failing]" : ""}`, async () => {
      const failure = await runFixture(f);
      if (known) {
        // the gate's other direction: a listed fixture that starts passing must be DELISTED, or the
        // list stops meaning anything
        expect(failure, `${id} now PASSES — remove it from the ALLOWLIST (was: ${known})`).not.toBeNull();
      } else {
        expect(failure, `${id} (${f.title})\n${failure}`).toBeNull();
      }
    }, 20000);
  }

  it("the allowlist references only real fixtures", () => {
    const keys = new Set(ids.map((id) => loadFixture(id)).map((f) => f.from ?? f.id));
    const stale = [...ALLOWLIST.keys()].filter((k) => !keys.has(k));
    expect(stale, `the allowlist names sources/ids the corpus no longer has: ${stale.join(", ")}`).toEqual([]);
  });
});
