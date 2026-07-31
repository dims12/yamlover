// yed-sync AGAINST THE DISK — the tag / kind-conversion ops (Stage 2 of the chapter port)
// applied through the REAL /api/edit handler over a temp tree. The pure suite (yed-sync.test.ts)
// pins the op shapes; this one pins that the server turns those shapes into the right bytes —
// the same doctrine as yed-parity.test.tsx: the assertion is the DISK.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { callBody } from "./http";
import { diffToOps } from "../src/client/renderers/yed-sync";
import { parseSource } from "../../yed/src/state";

/** Diff prev→next as the yed mount would, flush the batch through the real handler, read back. */
async function applied(prev: string, next: string): Promise<string> {
  const root = tmpTree({ "doc.yo": prev });
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  const d = diffToOps(":doc.yo", parseSource(prev), parseSource(next));
  expect(d.fallback, "these cases must stay surgical").toBe(false);
  const r = await callBody(h, "POST", "/api/edit", { edits: d.ops });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return fs.readFileSync(path.join(root, "doc.yo"), "utf8");
}

// The shapes here are the ones the CHAPTER projection emits: the document ROOT's own-line tag
// (the CHAPTER_META stamp) and POSITIONAL block entries (`- !!<…>` inline prefix — format.ts
// formatTarget only ever tags keyless blocks or the root). A tag on a KEYED child's value line
// (`a: !!<…>`) is NOT in the server's edit surgery today — the chapter never emits that shape.
describe("yed-sync tags on disk — retag, drop, conversion", () => {
  it("a positional block RETAG lands as the new `!!<…>` token", async () => {
    const out = await applied(
      "- !!<*yamlover: $defs: bullets>\n  - x\n",
      "- !!<*yamlover: $defs: numbered>\n  - x\n",
    );
    expect(out).toContain("$defs: numbered");
    expect(out).not.toContain("$defs: bullets");
    expect(out).toContain("- x");
  });

  it("a positional block's tag DROP removes the `!!<…>` token and nothing else", async () => {
    const out = await applied(
      "- !!<*yamlover: $defs: bullets>\n  - x\n",
      "-\n  - x\n",
    );
    expect(out).not.toContain("!!<");
    expect(out).toContain("- x");
  });

  it("the ROOT stamp and drop — the CHAPTER_META flow (own-line tag form)", async () => {
    const stamped = await applied("T\n- x\n", "!!<*yamlover: $defs: chapter>\nT\n- x\n");
    expect(stamped.split("\n")[0]).toBe("!!<*yamlover: $defs: chapter>");
    const dropped = await applied("!!<*yamlover: $defs: chapter>\nT\n- x\n", "T\n- x\n");
    expect(dropped).not.toContain("!!<");
    expect(dropped).toContain("T");
  });

  it("COMMENTS survive a retag — the meta-only emplace touches one token", async () => {
    const out = await applied(
      "# the banner\n- !!<*yamlover: $defs: bullets>\n  - x # keep me\n",
      "# the banner\n- !!<*yamlover: $defs: numbered>\n  - x # keep me\n",
    );
    expect(out).toContain("# the banner");
    expect(out).toContain("# keep me");
    expect(out).toContain("$defs: numbered");
    expect(out).not.toContain("$defs: bullets");
  });

  it("LEAF → CONTAINER (the leaf promoteFormat): one replace, tag + wrapped prose on disk", async () => {
    const out = await applied(
      "a: prose\nb: 1\n",
      "a: !!<*yamlover: $defs: bullets>\n  - prose\nb: 1\n",
    );
    expect(out).toContain("$defs: bullets");
    expect(out).toContain("- prose");
    expect(out).toContain("b: 1");
  });

  it("CONTAINER → LEAF: the replace drops the tag with the structure", async () => {
    const out = await applied(
      "a: !!<*yamlover: $defs: bullets>\n  - one\n  - two\nb: 1\n",
      "a: prose\nb: 1\n",
    );
    expect(out).not.toContain("!!<");
    expect(out).toContain("a: prose");
    expect(out).toContain("b: 1");
  });

  it("an INSERTED subtree's inline tag reaches the disk", async () => {
    const out = await applied(
      "a: 1\n",
      "a: 1\nkids: !!<*yamlover: $defs: bullets>\n  - x\n",
    );
    expect(out).toContain("a: 1");
    expect(out).toContain("$defs: bullets");
    expect(out).toContain("- x");
  });
});
